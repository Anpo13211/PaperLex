const PART_OF_SPEECH_TERMS = [
  '固有名詞',
  '他動詞',
  '自動詞',
  '助動詞',
  '代名詞',
  '形容詞',
  '前置詞',
  '接続詞',
  '間投詞',
  '限定詞',
  '接頭辞',
  '接尾辞',
  '動詞',
  '名詞',
  '副詞',
  '冠詞',
  '数詞',
  '熟語',
  '成句',
  '略語',
];
const PART_OF_SPEECH_ALTERNATION = PART_OF_SPEECH_TERMS.join('|');
const PART_OF_SPEECH_SEQUENCE = `(?:${PART_OF_SPEECH_ALTERNATION})(?:\\s*(?:${PART_OF_SPEECH_ALTERNATION}))*`;
const USAGE_SEQUENCE = '(?:｟[^｠\\n]{1,60}｠)*';
const GRAMMAR_HEADER = `${PART_OF_SPEECH_SEQUENCE}${USAGE_SEQUENCE}`;
const LATIN_HEADWORD = String.raw`\p{Script=Latin}[\p{Script=Latin}\p{M}･'’.-]*(?:\s+\p{Script=Latin}[\p{Script=Latin}\p{M}･'’.-]*)*`;
const FULL_ENTRY_HEADER = String.raw`(?<headword>${LATIN_HEADWORD})\s*\|(?<pronunciation>[^\n]{1,160}?)\|\s*(?<grammar>${GRAMMAR_HEADER})`;
const COMPACT_ENTRY_HEADER = String.raw`^(?<headword>${LATIN_HEADWORD})(?<grammar>${GRAMMAR_HEADER})`;
const INLINE_PART_OF_SPEECH_HEADER = String.raw`(?<grammar>${GRAMMAR_HEADER})\s*\|\s*(?<pronunciation>[^\n]{1,160}?)\s*\|`;

const PART_OF_SPEECH_LABELS = new Map([
  ['noun', '名詞'],
  ['proper noun', '固有名詞'],
  ['pronoun', '代名詞'],
  ['verb', '動詞'],
  ['phrasal verb', '句動詞'],
  ['auxiliary verb', '助動詞'],
  ['adjective', '形容詞'],
  ['adverb', '副詞'],
  ['preposition', '前置詞'],
  ['conjunction', '接続詞'],
  ['interjection', '間投詞'],
  ['exclamation', '間投詞'],
  ['article', '冠詞'],
  ['determiner', '限定詞'],
  ['numeral', '数詞'],
  ['prefix', '接頭辞'],
  ['suffix', '接尾辞'],
  ['abbreviation', '略語'],
  ['phrase', '句'],
  ['idiom', '熟語'],
]);

export function parseAppleDefinition(value) {
  const text = normalizeDocument(value);
  if (!text) return emptyDefinition();

  const extracted = extractTrailingReference(text);
  const definitionText = extracted.text;
  const fullEntries = splitFullEntries(definitionText);
  if (fullEntries) {
    const [main, ...derivatives] = fullEntries;
    return structuredDefinition(main, derivatives, extracted.reference);
  }

  const compactEntry = splitCompactEntry(definitionText);
  if (compactEntry) return structuredDefinition(compactEntry, [], extracted.reference);

  const block = parseSenseBlock(definitionText, false);
  const groups = [createAnonymousGroup(block)];
  return {
    lead: block.intro,
    headword: '',
    displayHeadword: '',
    pronunciation: '',
    numbered: block.numbered,
    senses: block.senses,
    groups,
    derivatives: [],
    reference: extracted.reference,
  };
}

export function appleDefinitionDetail(value) {
  const parsed = parseAppleDefinition(value);
  const groups = parsed.groups.map(decorateGroup);
  const derivatives = parsed.derivatives.map((entry) => ({
    ...entry,
    groups: entry.groups.map(decorateGroup),
  }));
  return {
    ...parsed,
    pronunciation: parsed.pronunciation || extractApplePronunciation(parsed.lead),
    groups,
    senses: groups.flatMap(({ senses }) => senses),
    derivatives,
  };
}

export function automaticExamplesForDetail(word) {
  return Array.isArray(word?.examples) ? word.examples : [];
}

export function appleDefinitionPreview(value) {
  const parsed = parseAppleDefinition(value);
  return parsed.senses[0]?.text || parsed.lead || '';
}

export function partOfSpeechLabel(value) {
  const partOfSpeech = normalizeSegment(value);
  if (!partOfSpeech) return '';
  const japanese = PART_OF_SPEECH_LABELS.get(partOfSpeech.toLocaleLowerCase('en'));
  return japanese ? `${japanese} / ${partOfSpeech}` : partOfSpeech;
}

function splitFullEntries(value) {
  const matches = [...value.matchAll(new RegExp(FULL_ENTRY_HEADER, 'gu'))];
  if (!matches.length || matches[0].index !== 0) return null;

  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? value.length;
    return createEntry(match, value.slice(bodyStart, bodyEnd));
  });
}

function splitCompactEntry(value) {
  const match = value.match(new RegExp(COMPACT_ENTRY_HEADER, 'u'));
  if (!match) return null;
  return createEntry(match, value.slice(match[0].length));
}

function createEntry(match, body) {
  const headword = normalizeSegment(match.groups?.headword);
  const pronunciation = normalizeSegment(match.groups?.pronunciation);
  return {
    header: normalizeSegment(match[0]),
    headword,
    displayHeadword: readableHeadword(headword),
    pronunciation,
    groups: splitPartOfSpeechGroups(body, match.groups?.grammar, pronunciation),
  };
}

function splitPartOfSpeechGroups(body, initialGrammar, initialPronunciation) {
  const source = String(body ?? '');
  const matches = [...source.matchAll(new RegExp(INLINE_PART_OF_SPEECH_HEADER, 'gu'))];
  const groups = [];
  const firstEnd = matches[0]?.index ?? source.length;
  groups.push(createGroup(initialGrammar, initialPronunciation, source.slice(0, firstEnd)));

  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    groups.push(createGroup(match.groups?.grammar, match.groups?.pronunciation, source.slice(start, end)));
  }
  return groups;
}

function createGroup(grammarHeader, pronunciation, body) {
  const grammar = parseGrammarHeader(grammarHeader);
  const block = parseSenseBlock(body, true);
  const senseGrammar = [];
  const senses = block.senses.map((sense) => {
    const cleaned = extractLeadingSenseGrammar(sense.text);
    for (const label of cleaned.grammar) {
      if (!senseGrammar.includes(label)) senseGrammar.push(label);
    }
    return { ...sense, text: cleaned.text };
  }).filter((sense) => sense.text || sense.examples.length);

  return {
    partOfSpeech: grammar.partOfSpeech,
    usage: grammar.usage,
    grammar: senseGrammar,
    pronunciation: normalizeSegment(pronunciation),
    intro: block.intro,
    numbered: block.numbered,
    senses,
  };
}

function createAnonymousGroup(block) {
  return {
    partOfSpeech: [],
    usage: [],
    grammar: [],
    pronunciation: '',
    intro: '',
    numbered: block.numbered,
    senses: block.senses,
  };
}

function structuredDefinition(main, derivatives, reference) {
  const senses = main.groups.flatMap(({ senses: groupSenses }) => groupSenses);
  return {
    lead: main.header,
    headword: main.headword,
    displayHeadword: main.displayHeadword,
    pronunciation: main.pronunciation,
    numbered: main.groups.some(({ numbered }) => numbered),
    senses,
    groups: main.groups,
    derivatives,
    reference,
  };
}

function decorateGroup(group) {
  const showMarkers = group.numbered || group.senses.length > 1;
  return {
    ...group,
    showMarkers,
    senses: group.senses.map((sense, index) => ({
      ...sense,
      displayMarker: String(index + 1),
    })),
  };
}

function parseSenseBlock(value, structured) {
  const definitionText = String(value ?? '');
  const circledMarkers = [...definitionText.matchAll(/[①-⑳]/gu)]
    .map((match) => ({ index: match.index, marker: match[0], length: match[0].length }));
  const markers = circledMarkers.length
    ? circledMarkers
    : findArabicSenseMarkers(definitionText, structured);

  if (!markers.length) {
    return {
      intro: '',
      numbered: false,
      senses: definitionText
        .split(/\n+/u)
        .map(normalizeSegment)
        .filter(Boolean)
        .map((sense) => createSense('', sense)),
    };
  }

  return {
    intro: normalizeSegment(definitionText.slice(0, markers[0].index)),
    numbered: true,
    senses: markers.map((match, index) => {
      const start = match.index + match.length;
      const end = markers[index + 1]?.index ?? definitionText.length;
      return createSense(match.marker, definitionText.slice(start, end));
    }).filter((sense) => sense.text || sense.examples.length),
  };
}

function findArabicSenseMarkers(value, allowSingleAtStart = false) {
  const candidates = [];
  const pattern = /(^|[\s詞])([1-9]|1\d|20)(?=\s*(?:[〖〈«｟(〘…]|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]))/gu;
  for (const match of value.matchAll(pattern)) {
    const prefix = match[1] || '';
    candidates.push({
      index: (match.index ?? 0) + prefix.length,
      marker: match[2],
      length: match[2].length,
    });
  }

  let best = [];
  for (let start = 0; start < candidates.length; start += 1) {
    if (candidates[start].marker !== '1') continue;
    const sequence = [candidates[start]];
    let expected = 2;
    for (let index = start + 1; index < candidates.length; index += 1) {
      const valueNumber = Number(candidates[index].marker);
      if (valueNumber === expected) {
        sequence.push(candidates[index]);
        expected += 1;
      } else if (valueNumber === 1 || valueNumber > expected) {
        break;
      }
    }
    if (sequence.length > best.length) best = sequence;
  }
  if (best.length >= 2) return best;
  if (allowSingleAtStart && best.length === 1 && !value.slice(0, best[0].index).trim()) return best;
  return [];
}

function createSense(marker, value) {
  const [definition = '', ...exampleParts] = String(value ?? '').split(/\s*▸\s*/u);
  return {
    marker,
    text: normalizeSegment(definition),
    examples: exampleParts.map(normalizeSegment).filter(Boolean),
  };
}

function parseGrammarHeader(value) {
  const grammar = normalizeSegment(value);
  const usage = [...grammar.matchAll(/｟([^｠\n]{1,60})｠/gu)].map((match) => normalizeSegment(match[1]));
  const compact = grammar.replace(/｟[^｠\n]{1,60}｠/gu, '').replace(/\s+/gu, '');
  const partOfSpeech = [];
  let cursor = 0;
  while (cursor < compact.length) {
    const label = PART_OF_SPEECH_TERMS.find((term) => compact.startsWith(term, cursor));
    if (!label) break;
    if (!partOfSpeech.includes(label)) partOfSpeech.push(label);
    cursor += label.length;
  }
  return { partOfSpeech, usage };
}

function extractLeadingSenseGrammar(value) {
  const text = normalizeSegment(value);
  const match = text.match(/^(C(?:[･/]?U)?|U(?:[･/]?C)?)(?=\s*(?:[〖〈«｟(〘…]|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]))/u);
  if (!match) return { text, grammar: [] };
  const marker = match[1];
  const grammar = [];
  if (marker.includes('C')) grammar.push('可算');
  if (marker.includes('U')) grammar.push('不可算');
  return { text: normalizeSegment(text.slice(match[0].length)), grammar };
}

function readableHeadword(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[･·]/gu, '')
    .normalize('NFC');
}

function emptyDefinition() {
  return {
    lead: '',
    headword: '',
    displayHeadword: '',
    pronunciation: '',
    numbered: false,
    senses: [],
    groups: [],
    derivatives: [],
    reference: '',
  };
}

function normalizeDocument(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function normalizeSegment(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function extractApplePronunciation(value) {
  const match = String(value ?? '').match(/^[^|\n]{1,180}\|\s*([^|\n]{1,180}?)\s*\|/u);
  return match ? normalizeSegment(match[1]) : '';
}

function extractTrailingReference(value) {
  const separateLine = value.match(/(?:^|\n[^\S\r\n]*)([↔⇔→←][^\r\n]+)[^\S\r\n]*$/u);
  if (separateLine && separateLine.index !== undefined) {
    return {
      text: value.slice(0, separateLine.index).trim(),
      reference: normalizeSegment(separateLine[1]),
    };
  }

  const afterSentence = value.match(/([。.!?！？])[^\S\r\n]+([↔⇔→←][^\r\n]+)[^\S\r\n]*$/u);
  if (!afterSentence || afterSentence.index === undefined) return { text: value, reference: '' };
  return {
    text: value.slice(0, afterSentence.index + afterSentence[1].length).trim(),
    reference: normalizeSegment(afterSentence[2]),
  };
}
