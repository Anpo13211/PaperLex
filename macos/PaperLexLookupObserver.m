#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

static NSString *PLCleanTerm(NSString *raw) {
    NSString *normalized = [(raw ?: @"") precomposedStringWithCompatibilityMapping];
    NSRegularExpression *whitespace = [NSRegularExpression regularExpressionWithPattern:@"\\s+" options:0 error:nil];
    normalized = [whitespace stringByReplacingMatchesInString:normalized options:0 range:NSMakeRange(0, normalized.length) withTemplate:@" "];
    return [normalized stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static NSString *PLCopyAXString(AXUIElementRef element, CFStringRef attribute) {
    if (!element) return @"";
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
    if (error != kAXErrorSuccess || !value) {
        if (value) CFRelease(value);
        return @"";
    }
    if (CFGetTypeID(value) != CFStringGetTypeID()) {
        CFRelease(value);
        return @"";
    }
    return CFBridgingRelease(value);
}

static BOOL PLCopyAXFrame(AXUIElementRef element, CGRect *frame) {
    if (!element || !frame) return NO;
    CFTypeRef positionValue = NULL;
    CFTypeRef sizeValue = NULL;
    AXError positionError = AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &positionValue);
    AXError sizeError = AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue);
    CGPoint position = CGPointZero;
    CGSize size = CGSizeZero;
    BOOL copied = positionError == kAXErrorSuccess && sizeError == kAXErrorSuccess
        && positionValue && sizeValue
        && CFGetTypeID(positionValue) == AXValueGetTypeID()
        && CFGetTypeID(sizeValue) == AXValueGetTypeID()
        && AXValueGetType((AXValueRef)positionValue) == kAXValueCGPointType
        && AXValueGetType((AXValueRef)sizeValue) == kAXValueCGSizeType
        && AXValueGetValue((AXValueRef)positionValue, kAXValueCGPointType, &position)
        && AXValueGetValue((AXValueRef)sizeValue, kAXValueCGSizeType, &size);
    if (positionValue) CFRelease(positionValue);
    if (sizeValue) CFRelease(sizeValue);
    if (copied) *frame = (CGRect){position, size};
    return copied;
}

static AXUIElementRef PLCopyMenuItemAtPosition(
    CGPoint location, pid_t processIdentifier, BOOL debugHierarchy, AXError *hitTestError) {
    if (hitTestError) *hitTestError = kAXErrorSuccess;
    if (processIdentifier <= 0) {
        if (hitTestError) *hitTestError = kAXErrorIllegalArgument;
        return NULL;
    }
    AXUIElementRef application = AXUIElementCreateApplication(processIdentifier);
    AXUIElementRef element = NULL;
    AXError error = AXUIElementCopyElementAtPosition(
        application, (float)location.x, (float)location.y, &element);
    CFRelease(application);
    if (error != kAXErrorSuccess || !element) {
        if (hitTestError) *hitTestError = error != kAXErrorSuccess ? error : kAXErrorNoValue;
        if (element) CFRelease(element);
        return NULL;
    }

    for (NSUInteger depth = 0; depth < 16; depth++) {
        NSString *role = PLCopyAXString(element, kAXRoleAttribute);
        if (debugHierarchy) {
            NSLog(@"PaperLex AX ancestor: depth=%lu role=%@ title=%@.",
                (unsigned long)depth, role, PLCopyAXString(element, kAXTitleAttribute));
        }
        if ([role isEqualToString:(__bridge NSString *)kAXMenuItemRole]) return element;

        CFTypeRef parent = NULL;
        AXError parentError = AXUIElementCopyAttributeValue(element, kAXParentAttribute, &parent);
        CFRelease(element);
        if (parentError != kAXErrorSuccess || !parent || CFGetTypeID(parent) != AXUIElementGetTypeID()) {
            if (hitTestError) {
                *hitTestError = (parentError == kAXErrorSuccess || parentError == kAXErrorAttributeUnsupported)
                    ? kAXErrorNoValue : parentError;
            }
            if (parent) CFRelease(parent);
            return NULL;
        }
        element = (AXUIElementRef)parent;
    }

    CFRelease(element);
    if (hitTestError) *hitTestError = kAXErrorNoValue;
    return NULL;
}

static BOOL PLIsLookupMenuItem(NSString *title, NSString *identifier) {
    (void)identifier;
    NSString *cleanTitle = PLCleanTerm(title);
    NSString *lowerTitle = cleanTitle.lowercaseString;
    if ([lowerTitle isEqualToString:@"look up"] || [lowerTitle isEqualToString:@"lookup"]) return YES;

    NSArray<NSArray<NSString *> *> *quotePairs = @[
        @[@"“", @"”"], @[@"\"", @"\""], @[@"「", @"」"], @[@"『", @"』"],
        @[@"‘", @"’"], @[@"'", @"'"],
    ];
    for (NSArray<NSString *> *pair in quotePairs) {
        NSRange opening = [cleanTitle rangeOfString:pair[0]];
        if (opening.location == NSNotFound) continue;
        NSUInteger termStart = NSMaxRange(opening);
        NSRange closing = [cleanTitle rangeOfString:pair[1] options:0 range:NSMakeRange(termStart, cleanTitle.length - termStart)];
        if (closing.location == NSNotFound || closing.location <= termStart) continue;

        NSString *prefix = PLCleanTerm([cleanTitle substringToIndex:opening.location]).lowercaseString;
        NSString *suffix = PLCleanTerm([cleanTitle substringFromIndex:NSMaxRange(closing)]);
        BOOL englishLookup = ([prefix isEqualToString:@"look up"] || [prefix isEqualToString:@"lookup"])
            && suffix.length == 0;
        BOOL japaneseLookup = prefix.length == 0
            && ([suffix isEqualToString:@"を調べる"] || [suffix isEqualToString:@"を辞書で調べる"]);
        if (englishLookup || japaneseLookup) return YES;
    }
    return NO;
}

static NSString *PLQuotedTerm(NSString *title) {
    NSArray<NSArray<NSString *> *> *quotePairs = @[
        @[@"“", @"”"], @[@"\"", @"\""], @[@"「", @"」"], @[@"『", @"』"],
        @[@"‘", @"’"], @[@"'", @"'"],
    ];
    for (NSArray<NSString *> *pair in quotePairs) {
        NSRange opening = [title rangeOfString:pair[0]];
        if (opening.location == NSNotFound) continue;
        NSUInteger start = NSMaxRange(opening);
        NSRange searchRange = NSMakeRange(start, title.length - start);
        NSRange closing = [title rangeOfString:pair[1] options:0 range:searchRange];
        if (closing.location == NSNotFound || closing.location <= start) continue;
        NSString *candidate = PLCleanTerm([title substringWithRange:NSMakeRange(start, closing.location - start)]);
        if (candidate.length > 0 && candidate.length <= 160) return candidate;
    }
    return @"";
}

static NSString *PLSelectedText(pid_t processIdentifier) {
    if (processIdentifier <= 0) return @"";
    AXUIElementRef application = AXUIElementCreateApplication(processIdentifier);
    if (!application) return @"";
    CFTypeRef focusedValue = NULL;
    AXError error = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute, &focusedValue);
    CFRelease(application);
    if (error != kAXErrorSuccess || !focusedValue) {
        if (focusedValue) CFRelease(focusedValue);
        return @"";
    }
    NSString *selected = PLCopyAXString((AXUIElementRef)focusedValue, kAXSelectedTextAttribute);
    CFRelease(focusedValue);
    selected = PLCleanTerm(selected);
    return selected.length <= 160 ? selected : @"";
}

static NSString *PLTermForLookupItem(NSString *title, NSString *identifier, NSString *selectedText) {
    if (!PLIsLookupMenuItem(title ?: @"", identifier ?: @"")) return @"";
    NSString *quoted = PLQuotedTerm(title ?: @"");
    if (quoted.length) return quoted;
    NSString *selected = PLCleanTerm(selectedText ?: @"");
    return selected.length > 0 && selected.length <= 160 ? selected : @"";
}

static NSString *PLPreferredSelection(NSString *currentText, NSString *cachedText, NSTimeInterval cachedAge) {
    NSString *current = PLCleanTerm(currentText ?: @"");
    if (current.length > 0 && current.length <= 160) return current;

    NSString *cached = PLCleanTerm(cachedText ?: @"");
    if (cachedAge >= 0 && cachedAge < 10.0 && cached.length > 0 && cached.length <= 160) return cached;
    return @"";
}

static const NSTimeInterval PLLookupSessionLifetime = 10.0;

static pid_t PLResolveLookupProcessIdentifier(
    BOOL beginsSession,
    NSString *frontmostBundleIdentifier,
    pid_t frontmostProcessIdentifier,
    pid_t cachedProcessIdentifier,
    NSTimeInterval cachedAge) {
    if (beginsSession) {
        return [frontmostBundleIdentifier isEqualToString:@"com.apple.Preview"]
            && frontmostProcessIdentifier > 0 ? frontmostProcessIdentifier : 0;
    }
    return cachedProcessIdentifier > 0 && cachedAge >= 0 && cachedAge < PLLookupSessionLifetime
        ? cachedProcessIdentifier : 0;
}

@interface PLLookupObserver : NSObject {
    CFMachPortRef _eventTap;
    CFRunLoopSourceRef _eventTapSource;
}
@property(nonatomic, strong) dispatch_queue_t captureQueue;
@property(nonatomic, copy) NSString *lastTerm;
@property(nonatomic) NSTimeInterval lastCaptureTime;
@property(nonatomic, copy) NSString *cachedSelection;
@property(nonatomic) NSTimeInterval cachedSelectionTime;
@property(nonatomic, copy) NSString *candidateTerm;
@property(nonatomic) CGRect candidateFrame;
@property(nonatomic) NSTimeInterval candidateTime;
@property(nonatomic) NSTimeInterval lastHitTestTime;
@property(nonatomic) pid_t lookupProcessIdentifier;
@property(nonatomic) NSTimeInterval lookupSessionTime;
@property(nonatomic) BOOL debugLogging;
@property(nonatomic) BOOL lastTrustedState;
@property(nonatomic) BOOL lastListenState;
@property(nonatomic) BOOL inputMonitoringRequested;
- (void)handleEventType:(CGEventType)eventType event:(CGEventRef)event;
- (void)reenableEventTap;
- (void)clearLookupSession;
@end

@implementation PLLookupObserver

static CGEventRef PLEventTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *userInfo) {
    (void)proxy;
    PLLookupObserver *observer = (__bridge PLLookupObserver *)userInfo;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (observer.debugLogging) {
            NSLog(@"PaperLex event tap disabled (%u); re-enabling.", (unsigned int)type);
        }
        [observer clearLookupSession];
        [observer reenableEventTap];
        return event;
    }
    [observer handleEventType:type event:event];
    return event;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _captureQueue = dispatch_queue_create("io.paperlex.lookup-observer.capture", DISPATCH_QUEUE_SERIAL);
        _debugLogging = [NSProcessInfo.processInfo.environment[@"PAPERLEX_OBSERVER_DEBUG"] boolValue];
    }
    return self;
}

- (void)writePermissionStatusWithAccessibility:(BOOL)accessibility inputMonitoring:(BOOL)inputMonitoring {
    NSString *statusPath = NSProcessInfo.processInfo.environment[@"PAPERLEX_OBSERVER_STATUS_PATH"];
    if (!statusPath.length) {
        NSString *applicationSupport = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
        statusPath = [applicationSupport stringByAppendingPathComponent:@"PaperLex/observer-permission.status"];
    }
    NSError *error = nil;
    NSString *status = @"NOT_TRUSTED\n";
    if (accessibility && inputMonitoring) status = @"TRUSTED\n";
    else if (!accessibility && !inputMonitoring) status = @"NEEDS_ACCESSIBILITY_AND_INPUT_MONITORING\n";
    else if (!accessibility) status = @"NEEDS_ACCESSIBILITY\n";
    else if (!inputMonitoring) status = @"NEEDS_INPUT_MONITORING\n";
    if (![status writeToFile:statusPath atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
        NSLog(@"PaperLex could not write observer permission status: %@", error.localizedDescription);
    }
}

- (void)removeEventTap {
    if (_eventTapSource) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), _eventTapSource, kCFRunLoopCommonModes);
        CFRelease(_eventTapSource);
        _eventTapSource = NULL;
    }
    if (_eventTap) {
        CFMachPortInvalidate(_eventTap);
        CFRelease(_eventTap);
        _eventTap = NULL;
    }
}

- (void)reenableEventTap {
    if (_eventTap) CGEventTapEnable(_eventTap, true);
}

- (void)clearLookupSession {
    self.lookupProcessIdentifier = 0;
    self.lookupSessionTime = 0;
    self.cachedSelection = @"";
    self.cachedSelectionTime = 0;
    self.candidateTerm = @"";
}

- (void)installEventMonitor {
    [self removeEventTap];
    if (!self.lastTrustedState || !self.lastListenState) return;

    CGEventMask mask = CGEventMaskBit(kCGEventRightMouseDown)
        | CGEventMaskBit(kCGEventMouseMoved)
        | CGEventMaskBit(kCGEventLeftMouseDown)
        | CGEventMaskBit(kCGEventLeftMouseUp);
    _eventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly, mask, PLEventTapCallback, (__bridge void *)self);
    if (!_eventTap) {
        NSLog(@"PaperLex lookup observer could not install the listen-only mouse event tap.");
        return;
    }
    _eventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, _eventTap, 0);
    if (!_eventTapSource) {
        NSLog(@"PaperLex lookup observer could not create the event tap run-loop source.");
        [self removeEventTap];
        return;
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), _eventTapSource, kCFRunLoopCommonModes);
    CGEventTapEnable(_eventTap, true);
}

- (void)dealloc {
    [self removeEventTap];
}

- (void)start {
    NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
    self.lastTrustedState = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
    self.lastListenState = CGPreflightListenEventAccess();
    if (self.lastTrustedState && !self.lastListenState) {
        self.inputMonitoringRequested = YES;
        self.lastListenState = CGRequestListenEventAccess();
    }
    [self writePermissionStatusWithAccessibility:self.lastTrustedState inputMonitoring:self.lastListenState];
    [self installEventMonitor];

    NSLog(@"PaperLex lookup observer started (Accessibility %@, Input Monitoring %@).",
        self.lastTrustedState ? @"allowed" : @"needed",
        self.lastListenState ? @"allowed" : @"needed");
    __weak typeof(self) weakSelf = self;
    [NSTimer scheduledTimerWithTimeInterval:5.0 repeats:YES block:^(__unused NSTimer *timer) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;
        BOOL trusted = AXIsProcessTrusted();
        BOOL listening = CGPreflightListenEventAccess();
        if (trusted && !listening && !strongSelf.inputMonitoringRequested) {
            strongSelf.inputMonitoringRequested = YES;
            listening = CGRequestListenEventAccess();
        }
        if (trusted != strongSelf.lastTrustedState || listening != strongSelf.lastListenState) {
            strongSelf.lastTrustedState = trusted;
            strongSelf.lastListenState = listening;
            [strongSelf writePermissionStatusWithAccessibility:trusted inputMonitoring:listening];
            [strongSelf installEventMonitor];
            NSLog(@"PaperLex permissions changed (Accessibility %@, Input Monitoring %@).",
                trusted ? @"enabled" : @"disabled",
                listening ? @"enabled" : @"disabled");
        } else if (trusted && listening && !strongSelf->_eventTap) {
            [strongSelf installEventMonitor];
        }
    }];
}

- (NSString *)consumeCandidateAtLocation:(CGPoint)location now:(NSTimeInterval)now {
    NSString *term = @"";
    if (self.candidateTerm.length && now - self.candidateTime < 3.0
        && CGRectContainsPoint(self.candidateFrame, location)) {
        term = self.candidateTerm;
    }
    self.candidateTerm = @"";
    return term;
}

- (void)saveTermIfNeeded:(NSString *)term now:(NSTimeInterval)now {
    if (!term.length) return;
    if ([term caseInsensitiveCompare:self.lastTerm ?: @""] == NSOrderedSame && now - self.lastCaptureTime < 2.0) return;
    self.lastTerm = term;
    self.lastCaptureTime = now;
    [self captureTerm:term];
}

- (void)handleEventType:(CGEventType)eventType event:(CGEventRef)event {
    if (!self.lastTrustedState || !self.lastListenState || !event) return;
    NSTimeInterval now = NSDate.timeIntervalSinceReferenceDate;
    CGPoint location = CGEventGetLocation(event);
    if (self.debugLogging) {
        NSLog(@"PaperLex mouse event: type=%u location=(%.1f, %.1f).",
            (unsigned int)eventType, location.x, location.y);
    }
    if (eventType == kCGEventRightMouseDown) {
        NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
        pid_t previewProcessIdentifier = PLResolveLookupProcessIdentifier(
            YES, frontmost.bundleIdentifier, frontmost.processIdentifier, 0, 0);
        [self clearLookupSession];
        if (previewProcessIdentifier <= 0) return;
        self.lookupProcessIdentifier = previewProcessIdentifier;
        self.lookupSessionTime = now;
        NSString *selection = PLSelectedText(previewProcessIdentifier);
        self.cachedSelection = selection;
        self.cachedSelectionTime = now;
        return;
    }

    pid_t previewProcessIdentifier = PLResolveLookupProcessIdentifier(
        NO, @"", 0, self.lookupProcessIdentifier, now - self.lookupSessionTime);
    if (previewProcessIdentifier <= 0) {
        [self clearLookupSession];
        return;
    }
    NSRunningApplication *previewApplication =
        [NSRunningApplication runningApplicationWithProcessIdentifier:previewProcessIdentifier];
    if (![previewApplication.bundleIdentifier isEqualToString:@"com.apple.Preview"]) {
        [self clearLookupSession];
        return;
    }

    if (eventType == kCGEventMouseMoved && now - self.lastHitTestTime < 0.04) return;
    self.lastHitTestTime = now;

    AXError hitTestError = kAXErrorSuccess;
    AXUIElementRef hitElement = PLCopyMenuItemAtPosition(
        location, previewProcessIdentifier,
        self.debugLogging && eventType == kCGEventLeftMouseDown, &hitTestError);
    if (!hitElement) {
        if (self.debugLogging) {
            NSLog(@"PaperLex AX menu hit-test failed: error=%d location=(%.1f, %.1f).",
                (int)hitTestError, location.x, location.y);
        }
        if (eventType == kCGEventLeftMouseUp) {
            [self saveTermIfNeeded:[self consumeCandidateAtLocation:location now:now] now:now];
            [self clearLookupSession];
        } else if (eventType == kCGEventMouseMoved || eventType == kCGEventLeftMouseDown) {
            self.candidateTerm = @"";
        }
        return;
    }

    NSString *role = PLCopyAXString(hitElement, kAXRoleAttribute);
    NSString *title = PLCopyAXString(hitElement, kAXTitleAttribute);
    NSString *identifier = PLCopyAXString(hitElement, kAXIdentifierAttribute);
    pid_t elementProcessIdentifier = 0;
    AXUIElementGetPid(hitElement, &elementProcessIdentifier);
    CGRect elementFrame = CGRectZero;
    BOOL hasFrame = PLCopyAXFrame(hitElement, &elementFrame);
    CFRelease(hitElement);

    if (self.debugLogging && [role isEqualToString:(__bridge NSString *)kAXMenuItemRole]) {
        NSLog(@"Preview menu click: title=%@ identifier=%@ pid=%d", title, identifier, elementProcessIdentifier);
    }
    if (elementProcessIdentifier > 0 && elementProcessIdentifier != previewProcessIdentifier) {
        if (eventType == kCGEventLeftMouseUp) [self clearLookupSession];
        else self.candidateTerm = @"";
        return;
    }
    NSString *term = PLTermForLookupItem(title, identifier, @"");
    if (!term.length && PLIsLookupMenuItem(title, identifier)) {
        NSString *currentSelection = PLSelectedText(previewProcessIdentifier);
        NSString *selectedText = PLPreferredSelection(
            currentSelection, self.cachedSelection, now - self.cachedSelectionTime);
        term = PLTermForLookupItem(title, identifier, selectedText);
    }
    if (eventType == kCGEventMouseMoved || eventType == kCGEventLeftMouseDown) {
        if (term.length && hasFrame) {
            self.candidateTerm = term;
            self.candidateFrame = elementFrame;
            self.candidateTime = now;
        } else {
            self.candidateTerm = @"";
        }
        return;
    }

    if (eventType != kCGEventLeftMouseUp) return;
    if (!term.length) term = [self consumeCandidateAtLocation:location now:now];
    else self.candidateTerm = @"";
    [self saveTermIfNeeded:term now:now];
    [self clearLookupSession];
}

- (void)captureTerm:(NSString *)term {
    NSString *capturedTerm = [term copy];
    dispatch_async(self.captureQueue, ^{
        NSString *helperPath = NSProcessInfo.processInfo.environment[@"PAPERLEX_CAPTURE_HELPER"];
        if (!helperPath.length) {
            NSString *applicationSupport = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
            helperPath = [applicationSupport stringByAppendingPathComponent:@"PaperLex/bin/paperlex-capture"];
        }
        if (![NSFileManager.defaultManager isExecutableFileAtPath:helperPath]) {
            NSLog(@"PaperLex capture helper is missing: %@", helperPath);
            return;
        }

        NSPipe *input = [NSPipe pipe];
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:helperPath];
        task.standardInput = input;
        NSMutableDictionary<NSString *, NSString *> *environment = NSProcessInfo.processInfo.environment.mutableCopy;
        environment[@"PAPERLEX_SOURCE_APP"] = @"Preview Look Up";
        task.environment = environment;
        NSError *launchError = nil;
        if (![task launchAndReturnError:&launchError]) {
            NSLog(@"PaperLex capture helper could not start: %@", launchError.localizedDescription);
            return;
        }
        NSData *data = [[[capturedTerm stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding] copy];
        [input.fileHandleForWriting writeData:data];
        [input.fileHandleForWriting closeFile];
        [task waitUntilExit];
        if (task.terminationStatus != 0) {
            NSLog(@"PaperLex failed to save “%@” (status %d).", capturedTerm, task.terminationStatus);
        }
    });
}

@end

static int PLPrintLine(NSString *value, int status) {
    NSData *data = [[value stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    fwrite(data.bytes, 1, data.length, stdout);
    return status;
}

int main(void) {
    @autoreleasepool {
        NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
        NSUInteger matchIndex = [arguments indexOfObject:@"--match-title"];
        if (matchIndex != NSNotFound) {
            NSString *title = matchIndex + 1 < arguments.count ? arguments[matchIndex + 1] : @"";
            NSString *selected = matchIndex + 2 < arguments.count ? arguments[matchIndex + 2] : @"";
            NSString *term = PLTermForLookupItem(title, @"", selected);
            return PLPrintLine(term.length ? term : @"NO_MATCH", term.length ? 0 : 1);
        }

        NSUInteger selectionIndex = [arguments indexOfObject:@"--resolve-selection"];
        if (selectionIndex != NSNotFound) {
            NSString *current = selectionIndex + 1 < arguments.count ? arguments[selectionIndex + 1] : @"";
            NSString *cached = selectionIndex + 2 < arguments.count ? arguments[selectionIndex + 2] : @"";
            NSTimeInterval age = selectionIndex + 3 < arguments.count
                ? arguments[selectionIndex + 3].doubleValue : 10.0;
            NSString *selection = PLPreferredSelection(current, cached, age);
            return PLPrintLine(selection.length ? selection : @"NO_SELECTION", selection.length ? 0 : 1);
        }

        NSUInteger sessionIndex = [arguments indexOfObject:@"--resolve-session"];
        if (sessionIndex != NSNotFound) {
            NSString *mode = sessionIndex + 1 < arguments.count ? arguments[sessionIndex + 1] : @"";
            NSString *bundleIdentifier = sessionIndex + 2 < arguments.count ? arguments[sessionIndex + 2] : @"";
            pid_t frontmostProcessIdentifier = sessionIndex + 3 < arguments.count
                ? (pid_t)arguments[sessionIndex + 3].intValue : 0;
            pid_t cachedProcessIdentifier = sessionIndex + 4 < arguments.count
                ? (pid_t)arguments[sessionIndex + 4].intValue : 0;
            NSTimeInterval cachedAge = sessionIndex + 5 < arguments.count
                ? arguments[sessionIndex + 5].doubleValue : PLLookupSessionLifetime;
            pid_t resolved = PLResolveLookupProcessIdentifier(
                [mode isEqualToString:@"begin"], bundleIdentifier,
                frontmostProcessIdentifier, cachedProcessIdentifier, cachedAge);
            return PLPrintLine(resolved > 0 ? [NSString stringWithFormat:@"%d", resolved] : @"NO_SESSION",
                resolved > 0 ? 0 : 1);
        }

        if ([arguments containsObject:@"--check-permissions"]) {
            BOOL trusted = AXIsProcessTrusted();
            BOOL listening = CGPreflightListenEventAccess();
            NSString *status = trusted && listening ? @"TRUSTED"
                : (!trusted && !listening ? @"NEEDS_ACCESSIBILITY_AND_INPUT_MONITORING"
                : (!trusted ? @"NEEDS_ACCESSIBILITY" : @"NEEDS_INPUT_MONITORING"));
            return PLPrintLine(status, trusted && listening ? 0 : 2);
        }

        if ([arguments containsObject:@"--request-permission"]) {
            NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
            BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
            BOOL listening = CGPreflightListenEventAccess() || CGRequestListenEventAccess();
            return PLPrintLine(trusted && listening ? @"TRUSTED" : @"PERMISSION_REQUESTED", trusted && listening ? 0 : 2);
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        __attribute__((objc_precise_lifetime)) PLLookupObserver *observer = [[PLLookupObserver alloc] init];
        [observer start];
        [NSRunLoop.currentRunLoop run];
    }
    return 0;
}
