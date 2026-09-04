import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appleDefinitionDetail,
  appleDefinitionPreview,
  parseAppleDefinition,
  partOfSpeechLabel,
  splitExamplePairs,
} from '../public/definition-format.js';

const denseAppleDefinition = 'アプリオリ 2ラテン•a priori〔「より先のものから」の意〕① アリストテレス的伝統では，原因・根拠であるという意味で，より先なる事象に基づいて，結果にあたる事象を導出する論証の性格をいう。② 近代では，「先天的」の意。生物学・心理学などで，ある機能が生得的に与えられていること。また哲学，特にカントの認識論では，認識・概念などが後天的な経験に依存せず，それに論理的に先立つものとして与えられていること。 ↔ア-ポステリオリ';

test('dense Apple dictionary text is separated into heading, senses, and reference', () => {
  const parsed = parseAppleDefinition(denseAppleDefinition);

  assert.equal(parsed.lead, 'アプリオリ 2ラテン•a priori〔「より先のものから」の意〕');
  assert.equal(parsed.numbered, true);
  assert.deepEqual(parsed.senses.map(({ marker }) => marker), ['①', '②']);
  assert.match(parsed.senses[0].text, /^アリストテレス的伝統では/);
  assert.match(parsed.senses[1].text, /^近代では/);
  assert.doesNotMatch(parsed.senses[1].text, /ア-ポステリオリ/);
  assert.equal(parsed.reference, '↔ア-ポステリオリ');
  assert.equal(parsed.groups[0].intro, '');
});

test('unnumbered dictionary paragraphs remain separate senses', () => {
  const parsed = parseAppleDefinition('第一の意味。\n\n第二の意味。\n→関連語');

  assert.equal(parsed.numbered, false);
  assert.deepEqual(parsed.senses.map(({ text }) => text), ['第一の意味。', '第二の意味。']);
  assert.equal(parsed.reference, '→関連語');
});

test('card preview uses the first numbered sense instead of the dense heading', () => {
  assert.match(appleDefinitionPreview(denseAppleDefinition), /^アリストテレス的伝統では/);
});

test('mathematical arrows inside a sense are not mistaken for related words', () => {
  const compactArrow = parseAppleDefinition('①写像 A→B を考える。');
  const spacedArrow = parseAppleDefinition('①写像 A → B を考える。');

  assert.equal(compactArrow.senses[0].text, '写像 A→B を考える。');
  assert.equal(compactArrow.reference, '');
  assert.equal(spacedArrow.senses[0].text, '写像 A → B を考える。');
  assert.equal(spacedArrow.reference, '');
});

test('part-of-speech labels put Japanese before the source label', () => {
  assert.equal(partOfSpeechLabel('adjective'), '形容詞 / adjective');
  assert.equal(partOfSpeechLabel('phrasal verb'), '句動詞 / phrasal verb');
  assert.equal(partOfSpeechLabel('specialist usage'), 'specialist usage');
});

test('plain Arabic Apple senses and their usage examples are separated', () => {
  const parsed = parseAppleDefinition(
    'there･by | ðèərbáɪ | 副詞｟かたく｠ 1 〖しばしば～ doing〗 それによって '
      + '▸ The company started mass production, thereby reducing costs. その会社は大量生産を始め, それによりコストを削減した. '
      + '2 それについて[関して]. 3 その近くに, その辺に.',
  );

  assert.equal(parsed.lead, 'there･by | ðèərbáɪ | 副詞｟かたく｠');
  assert.equal(parsed.numbered, true);
  assert.deepEqual(parsed.senses.map(({ marker }) => marker), ['1', '2', '3']);
  assert.equal(parsed.senses[0].text, 'それによって');
  assert.deepEqual(parsed.senses[0].usages, ['しばしば～ doing']);
  assert.equal(parsed.senses[0].examples.length, 1);
  assert.match(parsed.senses[0].examples[0], /^The company started mass production/);
  assert.equal(parsed.senses[1].text, 'それについて[関して].');
});

test('an Arabic first sense attached to a part-of-speech label is recognized', () => {
  const parsed = parseAppleDefinition(improveAppleDefinition);

  assert.deepEqual(parsed.senses.map(({ marker }) => marker), ['1', '2', '3']);
  assert.equal(parsed.lead, 'im･prove | ɪmprúːv | 動詞 他動詞');
  // 助詞が続く 〈物･事〉を は本文に残し、単独の主語表示だけを注記へ移す。
  assert.equal(parsed.senses[0].text, '〈物･事〉を改善する');
  assert.deepEqual(parsed.senses[0].subjects, ['人･事が']);
  assert.equal(appleDefinitionPreview(parsed.lead + '1 ' + parsed.senses[0].text + ' 2 二番目'), '〈物･事〉を改善する');
});

const improveAppleDefinition =
  'im･prove | ɪmprúːv | 動詞 他動詞1 〈人･事が〉〈物･事〉を改善する '
  + '▸ I want to improve my English. 私は英語がうまくなりたい. '
  + '2 〈土地･建物〉の価値を高める. 3 〈時間など〉を活用する.';

test('detail formatting falls back to the pronunciation in the Apple heading', () => {
  const detail = appleDefinitionDetail(improveAppleDefinition);

  assert.equal(detail.pronunciation, 'ɪmprúːv');
});

test('detail formatting gives numbered invoke senses sequential display markers', () => {
  const detail = appleDefinitionDetail(
    'in･voke | ɪnvóʊk | 動詞他動詞1 〈法律･権威など〉を援用する. '
      + '2 〈神など〉に祈願する. 3 〈感情･記憶など〉を呼び起こす.',
  );

  assert.deepEqual(detail.senses.map(({ displayMarker }) => displayMarker), ['1', '2', '3']);
});

test('detail formatting preserves circled source markers while normalizing their display markers', () => {
  const detail = appleDefinitionDetail(denseAppleDefinition);

  assert.deepEqual(
    detail.senses.map(({ marker, displayMarker }) => ({ marker, displayMarker })),
    [
      { marker: '①', displayMarker: '1' },
      { marker: '②', displayMarker: '2' },
    ],
  );
});

test('incidental numbers without an ordered sense sequence remain in one paragraph', () => {
  const parsed = parseAppleDefinition('モデル 2 を用い、2026 年の結果を説明する。');
  assert.equal(parsed.numbered, false);
  assert.equal(parsed.senses.length, 1);
  assert.equal(parsed.senses[0].text, 'モデル 2 を用い、2026 年の結果を説明する。');
});

test('dense inline derivative entries are separated from the main Apple definition', () => {
  const parsed = parseAppleDefinition(elucidateAppleDefinition);

  assert.equal(parsed.lead, 'e･lu･ci･date | ɪlúːsɪdèɪt | 動詞他動詞自動詞｟かたく｠');
  assert.equal(parsed.numbered, false);
  assert.equal(parsed.senses.length, 1);
  assert.match(parsed.senses[0].text, /^\(〈難解な事〉を\)解明する/);
  assert.deepEqual(parsed.groups[0].partOfSpeech, ['動詞', '他動詞', '自動詞']);
  assert.deepEqual(parsed.groups[0].usage, ['かたく']);
  assert.equal(parsed.derivatives.length, 2);
  assert.equal(parsed.derivatives[0].displayHeadword, 'elucidator');
  assert.equal(parsed.derivatives[0].pronunciation, '-tər');
  assert.deepEqual(parsed.derivatives[0].groups[0].partOfSpeech, ['名詞']);
  assert.equal(parsed.derivatives[0].groups[0].senses[0].text, '説明する人.');
  assert.equal(parsed.derivatives[1].displayHeadword, 'elucidatory');
  assert.equal(parsed.derivatives[1].pronunciation, '-dətɔ̀ːri|-dèɪt(ə)ri');
  assert.deepEqual(parsed.derivatives[1].groups[0].partOfSpeech, ['形容詞']);
  assert.equal(parsed.derivatives[1].groups[0].senses[0].text, '説明的な, 物事を明確にする.');
  assert.match(appleDefinitionPreview(parsed.lead + ' ' + parsed.senses[0].text), /^\(〈難解な事〉を\)解明する/);
});

const elucidateAppleDefinition =
  'e･lu･ci･date | ɪlúːsɪdèɪt | 動詞他動詞自動詞｟かたく｠ '
  + '(〈難解な事〉を)解明する, はっきりと説明する, 明らかにする(clarify). '
  + 'e･lú･ci･dà･tor | -tər | 名詞説明する人. '
  + 'e･lú･ci･da･tò･ry | -dətɔ̀ːri|-dèɪt(ə)ri | 形容詞説明的な, 物事を明確にする.';

test('detail formatting never numbers elucidate derivatives as meanings', () => {
  const detail = appleDefinitionDetail(elucidateAppleDefinition);

  assert.deepEqual(detail.senses.map(({ displayMarker }) => displayMarker), ['1']);
  assert.equal(detail.groups[0].showMarkers, false);
  assert.ok(detail.derivatives.every(({ groups }) => groups.every(({ showMarkers }) => !showMarkers)));
});

test('a derivative headword without its own gloss remains visible', () => {
  const parsed = parseAppleDefinition(
    'word | wɜːd | 名詞主な意味. derived | -d | 名詞derivative | -tɪv | 形容詞派生的な.',
  );

  assert.equal(parsed.senses.length, 1);
  assert.equal(parsed.derivatives.length, 2);
  assert.equal(parsed.derivatives[0].displayHeadword, 'derived');
  assert.equal(parsed.derivatives[0].groups[0].senses.length, 0);
  assert.equal(parsed.derivatives[1].displayHeadword, 'derivative');
  assert.equal(parsed.derivatives[1].groups[0].senses[0].text, '派生的な.');
});

const underscoreAppleDefinition =
  'ùnder･scóre動詞他動詞1 …を強調する, 明白にする(｟主に英｠ underline). '
  + '2 …に下線を引く(｟主に英｠ underline). 名詞 | -́--̀ | C下線, アンダーライン.';

test('compact underscore entry separates verb senses from its noun group', () => {
  const parsed = parseAppleDefinition(underscoreAppleDefinition);

  assert.equal(parsed.displayHeadword, 'underscore');
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].partOfSpeech, ['動詞', '他動詞']);
  assert.deepEqual(parsed.groups[0].senses.map(({ marker, text }) => ({ marker, text })), [
    { marker: '1', text: '…を強調する, 明白にする(underline).' },
    { marker: '2', text: '…に下線を引く(underline).' },
  ]);
  assert.deepEqual(parsed.groups[0].senses[0].registers, ['主に英']);
  assert.deepEqual(parsed.groups[1].partOfSpeech, ['名詞']);
  assert.equal(parsed.groups[1].pronunciation, '-́--̀');
  assert.deepEqual(parsed.groups[1].grammar, ['可算']);
  assert.equal(parsed.groups[1].senses[0].text, '下線, アンダーライン.');
  assert.equal(parsed.groups[1].numbered, false);
});

test('headword pronunciation and part of speech never leak into sense text', () => {
  for (const definition of [elucidateAppleDefinition, underscoreAppleDefinition]) {
    const parsed = parseAppleDefinition(definition);
    const senseText = parsed.groups.flatMap(({ senses }) => senses.map(({ text }) => text)).join(' ');
    assert.doesNotMatch(senseText, /e･lu|ùnder･scóre|\||動詞|名詞|形容詞/u);
  }
});

const sufficeAppleDefinition =
  'suf･fice | səfáɪs | 動詞｟かたく｠ (!進行形にしない) 自動詞〈物･事が〉 «…するのに/…には» 十分である «to do/for» '
  + '▸ A simple “thank you” will suffice. 単に「ありがとう」という言葉で十分である. '
  + 'Suffíce (it) to sày (that) .... 〖文頭で〗…と言えば十分である, …と言うにとどめておこう.';

const sufficientAppleDefinition =
  'suf･fi･cient | səfɪ́ʃ(ə)nt | 形容詞比較なし 1 ｟ややかたく｠ «…するのに/…にとって» 十分な, 足りる «to do/for» '
  + '(!enoughよりかたい語; ↔ insufficient) ▸ I have sufficient income. 十分な収入がある. '
  + '2 ｟古｠ 有能な; 十分資格がある. 名詞U｟ややかたく｠ 十分(の量)(enough) '
  + '▸ I\'ve had quite sufficient. 十分いただきました.';

const curateAppleDefinition =
  'cu･rate | kjʊ́ərət | 名詞C1 (英国国教会の)副牧師 (!rectorやvicarを助ける) . 2 (プロテスタントの)教区牧師; '
  + '(カトリックの)助任司祭. 動詞 | kju(ə)réɪt | 他動詞〈展示[展覧]会など〉を企画[主催]する (!しばしば受け身で) . '
  + '～̀\'s égg ｟英｠ よさと悪さを両方持つ物[事]; ピンキリ.';

test('a sense keeps the meaning itself and moves grammar notation into annotations', () => {
  const [sense] = appleDefinitionDetail(sufficeAppleDefinition).senses;

  assert.equal(sense.text, '十分である');
  assert.deepEqual(sense.patterns, ['…するのに/…には', 'to do/for']);
  assert.deepEqual(sense.subjects, ['物･事が']);
  assert.deepEqual(sense.notes, ['進行形にしない']);
});

test('an inline part-of-speech label starts its own group instead of joining the previous sense', () => {
  const { groups } = appleDefinitionDetail(sufficientAppleDefinition);

  assert.deepEqual(groups.map(({ partOfSpeech }) => partOfSpeech), [['形容詞'], ['名詞']]);
  assert.deepEqual(groups[0].senses.map(({ text }) => text), ['十分な, 足りる', '有能な; 十分資格がある.']);
  assert.deepEqual(groups[1].senses.map(({ text }) => text), ['十分(の量)(enough)']);
  assert.deepEqual(groups[1].grammar, ['不可算']);
  // 括弧ごと注記へ移すため、(!…) の中の ; で語義が割れない。
  assert.deepEqual(groups[0].senses[0].notes, ['enoughよりかたい語; ↔ insufficient']);
});

test('a countable marker before the first sense number does not hide the numbering', () => {
  const { groups } = appleDefinitionDetail(curateAppleDefinition);

  assert.deepEqual(groups.map(({ partOfSpeech }) => partOfSpeech), [['名詞'], ['動詞'], ['成句']]);
  assert.deepEqual(groups[0].grammar, ['可算']);
  assert.equal(groups[0].intro, '');
  assert.deepEqual(groups[0].senses.map(({ text }) => text), [
    '(英国国教会の)副牧師.',
    '(プロテスタントの)教区牧師; (カトリックの)助任司祭.',
  ]);
  assert.match(groups[2].senses[0].text, /^～̀'s égg/u);
});

test('an example splits into its English sentence and Japanese translation', () => {
  const [sense] = appleDefinitionDetail(sufficeAppleDefinition).senses;

  assert.deepEqual(splitExamplePairs(sense.examples[0]), [
    { english: 'A simple “thank you” will suffice.', japanese: '単に「ありがとう」という言葉で十分である.' },
    {
      english: 'Suffíce (it) to sày (that) ....',
      japanese: '〖文頭で〗…と言えば十分である, …と言うにとどめておこう.',
    },
  ]);
});

test('splitExamplePairs keeps a one-sided example usable', () => {
  assert.deepEqual(splitExamplePairs('必要十分条件.'), [{ english: '', japanese: '必要十分条件.' }]);
  assert.deepEqual(splitExamplePairs('an ephemeral cache'), [{ english: 'an ephemeral cache', japanese: '' }]);
  assert.deepEqual(splitExamplePairs('  '), []);
});
