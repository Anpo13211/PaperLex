#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>

// PDF から選択した語には、文末のピリオドや引用符、注記記号、行末ハイフンが混ざる。
// 残したまま DCSCopyTextDefinition を呼ぶと定義が空で返るため、保存前に見出し語の形へ揃える。
// 同じ規則を lib/normalize.mjs と hosted/worker/normalize.ts にも実装している。
static NSString *const PLControlCharacters = @"[\\u0000-\\u001F\\u007F]";
static NSString *const PLInvisibleCharacters = @"[\\u00AD\\u200B-\\u200D\\u2060\\uFEFF]";
static NSString *const PLLeadingPunctuation =
    @"^[\\s\"'`()\\[\\]{}<>«»‹›“”‘’„‚〈〉《》「」『』【】〔〕,;:!?¿¡.…·•*†‡§¶/\\\\|、。]+";
static NSString *const PLTrailingPunctuation =
    @"[\\s\"'`()\\[\\]{}<>«»‹›“”‘’„‚〈〉《》「」『』【】〔〕,;:!?¿¡…·•*†‡§¶/\\\\|、。\\-‐‑‒–—−]+$";
static NSString *const PLTrailingCitation = @"(?:\\[[\\d\\s,;–—-]{1,20}\\]|[\\u2070-\\u209F]+)$";
static NSString *const PLHyphens = @"[-‐‑‒–—−]";

static void WriteLine(NSString *message, FILE *stream) {
    NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    fwrite(data.bytes, 1, data.length, stream);
}

static NSString *ReadStandardInput(void) {
    NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
}

static NSString *ReplaceMatches(NSString *value, NSString *pattern, NSString *replacement) {
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
    if (!regex) return value;
    return [regex stringByReplacingMatchesInString:value
                                           options:0
                                             range:NSMakeRange(0, value.length)
                                      withTemplate:replacement];
}

static NSString *TrimWhitespace(NSString *value) {
    return [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static NSString *TrimEdgePunctuation(NSString *value) {
    NSString *term = value;
    for (NSUInteger pass = 0; pass < 8; pass++) {
        NSString *next = ReplaceMatches(term, PLLeadingPunctuation, @"");
        next = ReplaceMatches(next, PLTrailingCitation, @"");
        next = TrimWhitespace(ReplaceMatches(next, PLTrailingPunctuation, @""));
        if ([next isEqualToString:term]) return term;
        term = next;
    }
    return term;
}

// 文末のピリオドだけを落とし、e.g. や Ph.D. のような省略形はそのまま残す。
static NSString *DropSentencePeriod(NSString *value) {
    if (![value hasSuffix:@"."]) return value;
    NSString *stripped = ReplaceMatches(value, @"\\.+$", @"");
    if (!stripped.length) return value;
    if ([stripped rangeOfString:@"."].location != NSNotFound) return value;
    return stripped;
}

static NSString *CleanTerm(NSString *raw) {
    NSString *value = [(raw ?: @"") precomposedStringWithCompatibilityMapping];
    value = ReplaceMatches(value, PLControlCharacters, @" ");
    value = ReplaceMatches(value, PLInvisibleCharacters, @"");
    value = TrimWhitespace(ReplaceMatches(value, @"\\s+", @" "));
    return TrimEdgePunctuation(DropSentencePeriod(TrimEdgePunctuation(value)));
}

static NSString *CopyDefinition(NSString *term) {
    CFStringRef copied = DCSCopyTextDefinition(
        NULL,
        (__bridge CFStringRef)term,
        CFRangeMake(0, (CFIndex)term.length)
    );
    return copied ? CFBridgingRelease(copied) : @"";
}

// 語形を整えても引けない場合の控えめな再試行。
// 行末ハイフンで分断された語 (suf-fice) は、連結形が引けたときだけ見出し語として採用する。
// 大文字だけの語は表記を変えずに引き直す。
static NSString *DictionaryDefinition(NSString **term) {
    NSString *definition = CopyDefinition(*term);
    if (definition.length) return definition;

    if (![*term containsString:@" "]) {
        NSString *joined = ReplaceMatches(*term, PLHyphens, @"");
        if (joined.length && ![joined isEqualToString:*term]) {
            definition = CopyDefinition(joined);
            if (definition.length) {
                *term = joined;
                return definition;
            }
        }
    }

    NSString *lowercased = [*term lowercaseString];
    if (![lowercased isEqualToString:*term]) {
        definition = CopyDefinition(lowercased);
        if (definition.length) return definition;
    }
    return @"";
}

static NSDictionary *ReadConfiguration(void) {
    NSString *applicationSupport = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    NSString *path = [applicationSupport stringByAppendingPathComponent:@"PaperLex/capture.json"];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return @{};
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : @{};
}

static int PostCapture(NSDictionary *payload, NSDictionary *configuration, BOOL definitionMissing) {
    NSString *baseURL = configuration[@"baseURL"] ?: @"http://127.0.0.1:8787";
    baseURL = [baseURL stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    while ([baseURL hasSuffix:@"/"]) baseURL = [baseURL substringToIndex:baseURL.length - 1];
    NSURL *url = [NSURL URLWithString:[baseURL stringByAppendingString:@"/api/capture"]];
    if (!url) {
        WriteLine(@"PaperLex の接続先URLが不正です。", stderr);
        return 3;
    }

    NSError *jsonError = nil;
    NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&jsonError];
    if (!body) {
        WriteLine([NSString stringWithFormat:@"PaperLex 送信データを作れません: %@", jsonError.localizedDescription], stderr);
        return 3;
    }

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    request.HTTPBody = body;
    request.timeoutInterval = 18.0;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    NSString *token = configuration[@"token"];
    if (token.length) [request setValue:token forHTTPHeaderField:@"X-PaperLex-Token"];
    NSString *sitesBearerToken = configuration[@"sitesBearerToken"];
    if (sitesBearerToken.length) {
        [request setValue:[@"Bearer " stringByAppendingString:sitesBearerToken]
       forHTTPHeaderField:@"OAI-Sites-Authorization"];
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSData *responseData = nil;
    __block NSHTTPURLResponse *httpResponse = nil;
    __block NSError *networkError = nil;
    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
        dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            responseData = data;
            httpResponse = (NSHTTPURLResponse *)response;
            networkError = error;
            dispatch_semaphore_signal(semaphore);
        }];
    [task resume];

    long waitResult = dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC));
    if (waitResult != 0) {
        [task cancel];
        WriteLine(@"PaperLex への保存がタイムアウトしました。", stderr);
        return 4;
    }
    if (networkError) {
        WriteLine([NSString stringWithFormat:@"PaperLex に接続できません: %@", networkError.localizedDescription], stderr);
        return 4;
    }

    id responseJSON = responseData ? [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil] : nil;
    if (httpResponse.statusCode < 200 || httpResponse.statusCode >= 300) {
        NSString *message = [responseJSON isKindOfClass:[NSDictionary class]] ? responseJSON[@"error"] : nil;
        WriteLine(message.length ? message : [NSString stringWithFormat:@"PaperLex の保存に失敗しました (%ld)", (long)httpResponse.statusCode], stderr);
        return 5;
    }

    NSDictionary *word = [responseJSON isKindOfClass:[NSDictionary class]] ? responseJSON[@"word"] : nil;
    NSString *term = [word isKindOfClass:[NSDictionary class]] ? word[@"term"] : payload[@"term"];
    NSNumber *count = [word isKindOfClass:[NSDictionary class]] ? word[@"encounterCount"] : nil;
    BOOL created = [responseJSON isKindOfClass:[NSDictionary class]] ? [responseJSON[@"created"] boolValue] : YES;
    // 辞書が引けなかったことを黙って保存すると気付けないので、記録に残す。
    NSString *note = definitionMissing ? @"（Apple辞書の定義が見つかりませんでした）" : @"";
    NSString *message = created
        ? [NSString stringWithFormat:@"「%@」を保存しました%@", term, note]
        : [NSString stringWithFormat:@"「%@」を%@回目として記録しました%@", term, count ?: @2, note];
    WriteLine(message, stdout);
    return 0;
}

int main(void) {
    @autoreleasepool {
        NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
        BOOL definitionOnly = [arguments containsObject:@"--definition-only"];
        BOOL canonicalOnly = [arguments containsObject:@"--canonical-only"];
        BOOL dryRun = [arguments containsObject:@"--dry-run"];
        NSString *argumentTerm = @"";
        for (NSUInteger index = 1; index < arguments.count; index++) {
            NSString *candidate = arguments[index];
            if (![candidate hasPrefix:@"--"]) {
                argumentTerm = candidate;
                break;
            }
        }

        NSString *term = CleanTerm(argumentTerm.length ? argumentTerm : ReadStandardInput());
        if (!term.length) {
            WriteLine(@"単語または熟語を選択してください。", stderr);
            return 2;
        }
        if (term.length > 160) {
            WriteLine(@"選択範囲が長すぎます。160文字以内の単語・熟語を選んでください。", stderr);
            return 2;
        }
        if (canonicalOnly) {
            WriteLine(term, stdout);
            return 0;
        }

        NSString *definition = DictionaryDefinition(&term);
        if (definitionOnly) {
            WriteLine(definition.length ? definition : @"NO_DEFINITION", stdout);
            return definition.length ? 0 : 1;
        }

        NSDictionary *environment = NSProcessInfo.processInfo.environment;
        NSDictionary *payload = @{
            @"term": term,
            @"appleDefinition": definition ?: @"",
            @"sourceApp": environment[@"PAPERLEX_SOURCE_APP"] ?: @"Preview",
            @"sourceTitle": environment[@"PAPERLEX_SOURCE_TITLE"] ?: @"",
        };

        if (dryRun) {
            NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingPrettyPrinted error:nil];
            WriteLine([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding], stdout);
            return 0;
        }

        return PostCapture(payload, ReadConfiguration(), definition.length == 0);
    }
}
