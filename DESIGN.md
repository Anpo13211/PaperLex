# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-01
- Primary product surfaces: macOS Preview Look Up observer, local capture service, remotely hosted responsive vocabulary web app, installable PWA.
- Evidence reviewed: the existing paper-dashboard integration context; the current `public/app.js`, `public/styles.css`, and `public/definition-format.js`; saved Apple Dictionary shapes for `a-priori`, `thereby`, `elucidate`, `invoke`, and `improve`; Free Dictionary API's optional `definitions[].example`; Wiktionary's structured definition fallback and attribution requirements; and Tatoeba's stable sentence-search API plus per-sentence author/license metadata. No external component library, screenshots, or brand assets were present.

## Brand
- Personality: Quiet, studious, dependable, and slightly tactile, like a well-kept research notebook.
- Trust signals: Visible save state, explicit dictionary sources, editable meanings, encounter counts, and a one-click JSON backup.
- Avoid: Gamified streak pressure, decorative gradients, dense admin-dashboard chrome, and claims that an automatically fetched definition is infallible.

## Product goals
- Goals: Turn Preview's normal Look Up action into a durable vocabulary record without changing its dictionary UI; structure every supported Apple Dictionary definition shape consistently; recover English definitions after provider outages; attach useful example sentences automatically; make repeat encounters visible; and support review from any network while the Mac is asleep.
- Non-goals: Replacing or controlling Preview's built-in Look Up UI, suppressing input events, full PDF annotation management, social/shared decks, or exposing vocabulary data to anonymous visitors.
- Success signals: Capture persists before enrichment finishes; duplicate capture increments the encounter count; every existing and future entry follows the same detail template demonstrated by `improve`; Japanese senses and embedded examples are visibly separated; part-of-speech changes form distinct groups; derivative headwords never become numbered senses; an English-definition outage shows a retryable state instead of removing the section; mobile detail scrolling remains stable; the list is readable at 320 px width; hosted data remains available when the Mac is off; and data can be exported without proprietary tooling.

## Personas and jobs
- Primary personas: A Japanese-speaking researcher who reads English papers in Preview and repeatedly encounters unfamiliar terminology.
- User jobs: Capture without breaking reading flow; recover Japanese/English definitions and examples; recognize repeated terms; add personal nuance; review from a phone.
- Key contexts of use: Desktop paper reading, brief mobile review from arbitrary networks, Mac-off review through the hosted app, and occasional offline viewing of the last synchronized list.

## Information architecture
- Primary navigation: A single vocabulary library with search, status filters, sorting, add, and backup actions.
- Core routes/screens: `/` library; owner-only hosted sign-in; word detail dialog; add-term dialog; cloud modeの localhost entry redirect; `/?local=1` local recovery snapshot.
- Content hierarchy: Term and pronunciation first; concise first Japanese sense second; recurrence/status metadata third. In detail, user-authored meaning stays first when present, followed by a dictionary heading, individually numbered Japanese senses and embedded usage examples, an always-present automatic-example section, an always-present English-definition section with loading/error/retry states, notes, and encounter history. `improve` is the canonical detail specimen; provider-specific missing data may change content, but never the section order or component shape.

## Design principles
- Principle 1: Capture first, enrich second. A lookup outage must not lose the selected term.
- Principle 2: Recurrence is information. Duplicate terms become a stronger learning signal rather than duplicate cards.
- Principle 3: Keep provenance visible. Apple Dictionary text, Free Dictionary API content, Tatoeba sentences, and user-authored notes remain distinct; corpus examples retain their sentence link, author, and license.
- Tradeoffs: The Mac keeps the pre-migration local database as a recovery snapshot, while the hosted D1 database is authoritative for new captures and anywhere-access. In cloud mode the localhost document entry redirects to that same private URL; `?local=1` explicitly opens the recovery snapshot instead of pretending the two databases are synchronized. A private hosted URL plus a dedicated identity-less capture credential adds deployment complexity but avoids exposing the vocabulary library publicly; server-side route checks restrict that credential to capture only.

## Visual language
- Color: Warm paper background, deep ink text, cobalt action color, muted moss success, and restrained amber attention state.
- Typography: System sans-serif for UI and long dictionary text, with a restrained serif reserved for vocabulary terms and pronunciation. Definition text uses at least 16 px with 1.75-1.9 line height.
- Spacing/layout rhythm: 4/8 px rhythm, generous card padding, compact toolbars, and a 72 rem reading width.
- Shape/radius/elevation: 12-18 px radii with thin borders and soft single-layer shadows.
- Motion: 140-220 ms transitions for toast messages and desktop card hover; mobile detail sheets avoid entry transforms, fixed texture repaints, and live blur while scrolling. Preserve scroll position when asynchronous detail data arrives.
- Imagery/iconography: Letterform-based PaperLex mark and simple inline SVG icons; no stock imagery.

## Components
- Existing components to reuse: The existing dashboard's `Aa 単語帳` navigation entry; no reusable source components exist.
- New/changed components: App header, statistics strip, search/sort toolbar, status chips, word cards, empty/error states, stable-scroll detail dialog, canonical `improve`-style structured Japanese meaning groups with part-of-speech chips, true sense markers, a separate derivative-word area, and embedded example blocks, attributed always-present automatic-example cards, always-present English-definition section with retry, English meaning cards, synonym chips, add dialog, hosted sign-in boundary, toast, and offline banner.
- Variants and states: New/learning/mastered status; Japanese definition numbered/unnumbered/compound-entry shapes; English lookup pending/complete/not-found/unavailable; normal/repeated word; desktop/mobile card density.
- Token/component ownership: CSS custom properties and semantic HTML in `public/styles.css` and `public/index.html`; no additional design-system layer.

## Accessibility
- Target standard: WCAG 2.2 AA for the web surface.
- Keyboard/focus behavior: Native buttons, inputs, selects, and dialogs; visible focus ring; Escape closes dialogs; card actions are not hover-only.
- Contrast/readability: Body text at least 16 px on mobile, strong ink/paper contrast, and status conveyed by label plus color.
- Screen-reader semantics: Landmark elements, explicit labels, live regions for save/error feedback, semantic ordered lists/headings, numbered automatic examples, and text labels for examples, sources, related words, and synonyms.
- Reduced motion and sensory considerations: Honor `prefers-reduced-motion`; do not rely on animation or color alone.

## Responsive behavior
- Supported breakpoints/devices: Current Safari/Chrome/Firefox desktop and mobile; minimum layout width 320 px.
- Layout adaptations: Two-column library/details behavior is represented by a centered dialog on desktop and a bottom sheet on mobile; controls wrap without horizontal scrolling; dictionary headings stack at narrow widths; the detail sheet is the only vertical scroll container; and mobile sticky surfaces use opaque backgrounds without backdrop blur.
- Touch/hover differences: Minimum 44 px primary touch targets; hover decoration is supplemental.

## Interaction states
- Loading: Skeleton-like quiet cards and disabled save controls with direct status text.
- Empty: Explain the Preview right-click workflow and offer manual addition.
- Error: Preserve the term where possible, distinguish unavailable automatic examples from "no example found," show a retryable lookup state, and keep errors concise.
- Success: Preview's normal Look Up panel remains authoritative; PaperLex captures asynchronously without adding a modal or stealing focus.
- Disabled: Reduced contrast plus `disabled` semantics and explanatory copy when relevant.
- Offline/slow network, if applicable: Show cached vocabulary read-only, keep the shell available, clearly label it as the last synchronized copy, preserve local capture for later synchronization, and distinguish dictionary-provider failure from a genuinely missing word.

## Content voice
- Tone: Calm, concise Japanese; definitions retain their source language.
- Terminology: Use `保存`, `出現回数`, `復習状態`, and `自分の意味`; call the background helper `PaperLex Observer` and the fallback service `PaperLex に保存`.
- Microcopy rules: State the action and result; call corpus content `自動例文`; label Tatoeba attribution explicitly; avoid motivational scoring and ambiguous icons without text or accessible labels.

## Implementation constraints
- Framework/styling system: Local fallback remains a dependency-free Node.js server using built-in `node:sqlite`; the hosted surface uses the same vanilla HTML/CSS/ES modules behind a Cloudflare Worker-compatible Sites build and D1; passive macOS Objective-C Accessibility observer plus capture-helper fallback.
- Design-token constraints: One CSS token layer only; use system fonts and local assets.
- Performance constraints: First shell under 150 KB excluding optional audio; dictionary and example lookups run concurrently with separate bounded timeouts; cache at most three corpus examples per term; no PDF content upload.
- Compatibility constraints: macOS Preview must expose selectable text and its Look Up menu through Accessibility; scanned PDFs need OCR before capture; the passive mouse observer requires explicit Accessibility and Input Monitoring permission; do not replace or re-sign the Observer for hosted configuration changes; current Node.js with `node:sqlite` remains the local fallback; hosted runtime code must avoid Node-only APIs and keep secrets in Sites runtime settings.
- Failure boundary: The observer only reads Preview accessibility state and invokes capture asynchronously. It never suppresses events or performs AX actions; on permission, lookup, or server failure, Preview's normal Look Up behavior remains unchanged.
- Test/screenshot expectations: Node unit/API tests, pure formatter tests using a real dense Apple definition shape, Objective-C helper compilation, localized menu-match rejection tests, Automator workflow validation, responsive screenshots at desktop and phone widths when a browser surface is available, and a live capture smoke test.

## Open questions
- [x] Owner-only Sites capture bypass credential issued, stored mode `0600`, and restricted server-side to tokenized capture / implementation / 2026-09-01.
- [ ] Confirm whether the user's enabled Apple dictionaries include the desired Japanese-English source / user / affects Japanese definition richness.
- [ ] Confirm whether original paper sentence/title capture is worth Accessibility permission / user / affects provenance depth.
