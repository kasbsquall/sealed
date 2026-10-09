---
name: Sealed
description: Sealed-bid price negotiation between AI agents on Monad, documented as a carbon triplicate form on a slate desk.
colors:
  desk: "oklch(33% 0.02 250)"
  desk-hi: "oklch(37% 0.022 250)"
  on-desk: "oklch(95% 0.008 240)"
  on-desk-2: "oklch(84% 0.014 245)"
  paper-w: "oklch(97.5% 0.006 240)"
  paper-y: "oklch(92% 0.11 100)"
  paper-p: "oklch(89% 0.055 8)"
  stamp-ground: "oklch(99% 0.004 240)"
  carbon: "oklch(36% 0.14 268)"
  print: "oklch(50% 0.08 165)"
  print-text: "oklch(41% 0.08 165)"
  print-deep: "oklch(28% 0.05 165)"
  line: "color-mix(in oklab, oklch(50% 0.08 165) 42%, transparent)"
  line-soft: "color-mix(in oklab, oklch(50% 0.08 165) 22%, transparent)"
  deal: "#ff4f1a"
typography:
  display:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(56px, 7vw, 96px)"
    fontWeight: 800
    lineHeight: 0.86
    letterSpacing: "-0.04em"
    fontVariation: "'wdth' 118"
  headline:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(30px, 4.3vw, 62px)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.034em"
    fontVariation: "'wdth' 118"
  section:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(28px, 3.3vw, 46px)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 122"
  form-header:
    fontFamily: "Archivo, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 125"
  title:
    fontFamily: "Archivo, sans-serif"
    fontSize: "23px"
    fontWeight: 650
    lineHeight: 1.22
    letterSpacing: "-0.012em"
  body:
    fontFamily: "Archivo, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'tnum', 'lnum', 'zero'"
  body-sm:
    fontFamily: "Archivo, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Archivo, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.01em"
  typed:
    fontFamily: "Courier Prime, monospace"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.35
  typed-sm:
    fontFamily: "Courier Prime, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.35
  typed-figure:
    fontFamily: "Courier Prime, monospace"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
  stamp-figure:
    fontFamily: "Archivo, sans-serif"
    fontSize: "44px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 125"
  stamp-word:
    fontFamily: "Archivo, sans-serif"
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 125"
rounded:
  none: "0px"
  dot: "50%"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "12px"
  md: "22px"
  lg: "48px"
  section: "96px"
  section-mobile: "64px"
components:
  button-primary:
    backgroundColor: "{colors.carbon}"
    textColor: "{colors.paper-w}"
    rounded: "{rounded.none}"
    padding: "11px 22px 11px 11px"
    height: "56px"
  button-copy:
    backgroundColor: "transparent"
    textColor: "{colors.print-deep}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "34px"
  button-copy-done:
    backgroundColor: "{colors.print-deep}"
    textColor: "{colors.paper-w}"
  filing-tab-buyer:
    backgroundColor: "{colors.paper-w}"
    textColor: "{colors.print-deep}"
    typography: "{typography.body-sm}"
    padding: "9px 20px 11px"
    height: "40px"
  filing-tab-seller:
    backgroundColor: "{colors.paper-y}"
    textColor: "{colors.print-deep}"
  filing-tab-chain:
    backgroundColor: "{colors.paper-p}"
    textColor: "{colors.print-deep}"
  form-field:
    textColor: "{colors.carbon}"
    typography: "{typography.typed}"
    rounded: "{rounded.none}"
    padding: "6px 12px 8px 14px"
  stamp-settled:
    backgroundColor: "{colors.stamp-ground}"
    textColor: "{colors.deal}"
    rounded: "{rounded.none}"
    padding: "6px 18px 8px"
  stamp-carbon:
    textColor: "{colors.carbon}"
    rounded: "{rounded.none}"
  command-block:
    textColor: "{colors.carbon}"
    typography: "{typography.typed-sm}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
  link-typed:
    textColor: "{colors.carbon}"
    typography: "{typography.typed-sm}"
  nav-link:
    textColor: "{colors.on-desk-2}"
    padding: "8px 10px"
    height: "36px"
---

# Design System: Sealed

## Overview

**Creative North Star: "The Carbon Triplicate"**

Sealed is drawn as office paperwork. A fanned set of three carbon copies lies on a dark slate desk: a cool white buyer copy, a canary seller copy and a pink chain copy. Each copy shows only what its party may know. Pre-printed form furniture (rules, box labels, column heads) is in dropout green ink, and everything typed onto the form is carbon blue-violet in a typewriter face. A field that a copy must not receive is covered by a pre-printed security crosshatch, so the hiding is something you can see.

The density is that of a real business form. Data sits in ruled boxes and ruled tables with tight internal spacing, and the air goes between documents on the desk, never inside the rows. Corners are square everywhere, depth comes from paper resting on the desk, and there is one moment of color: an orange rubber stamp at the settlement. The same orange appears in the small square at the center of the Cruce isotipo.

Rejected in the shipped build: the crypto dashboard look (dark glass, neon, gradient cards) and a vertical stepper of numbered process cards. Steps are rows in ruled tables or numbered clauses with a rule under each.

**Key Characteristics:**
- Slate desk ground with grain; paper copies with multiply grain and one soft paper shadow.
- Two inks on paper: dropout green for what is printed, carbon blue-violet for what is typed.
- Archivo with its width axis (100% to 125%) for printed text; Courier Prime only for typed data.
- Square corners, 1px ruled boxes, 2px header rules, perforated stubs, trapezoid filing tabs.
- Orange `#FF4F1A` lives in exactly two places: the settlement stamp and the isotipo square.
- Phosphor icons, Light weight only. No emoji anywhere.

## Colors

The palette is a desk, three paper stocks and two inks, with one signal orange that marks the deal.

### Primary
- **Settlement Orange** (`#ff4f1a`, token `deal`): the ink of the SETTLED rubber stamp and the inner square of the Cruce isotipo. Nothing else. It never colors text, links, buttons, borders, charts or backgrounds.

### Secondary
- **Carbon Blue-Violet** (`carbon`, sRGB about `#1f3385`): everything typed onto a form (Courier Prime values, links on paper, checkmarks, radio dots), the primary Replay button fill, the expiry stamp, the VOID mark, and focus rings on paper. Text selection on the desk uses it as the highlight.

### Tertiary
- **Dropout Green** (`print`, about `#2f7258`): pre-printed form rules, box borders, checkbox and radio outlines, and the base of the security crosshatch.
- **Dropout Green Text** (`print-text`, about `#0f583f`): field labels, column heads, captions and secondary prose on paper. This is the readable green for 12 to 17px text.
- **Deep Print** (`print-deep`, about `#0a3123`): headings, the hook, figures and strong values on paper. Default text color of a paper sheet.
- **Ruled Line** (`line`, 42% of `print` over transparent) and **Soft Rule** (`line-soft`, 22%): 1px field dividers and table row rules. `line-soft` is for dense ledgers (order log, passbook).

### Neutral
- **Slate Desk** (`desk`, about `#2e363f`): page ground, also the browser theme color. Carries an SVG grain in soft-light blend and a radial lift to **Desk Highlight** (`desk-hi`, about `#37414b`) at the top left.
- **Desk Text** (`on-desk`, about `#eaeff3`): section headings, wordmark and focus rings on the desk.
- **Desk Text Muted** (`on-desk-2`, about `#c3ccd3`): section intros, nav links and footer text.
- **Buyer Copy White** (`paper-w`, about `#f3f7fa`): buyer copy, record documents, button text on carbon.
- **Seller Copy Canary** (`paper-y`, about `#f5e78f`): seller copy and its tab.
- **Chain Copy Pink** (`paper-p`, about `#fcccd4`): chain copy, its tab, and the record when viewed through the chain lens.
- **Stamp Clear Zone** (`stamp-ground`, about `#f9fcfe`): the unprinted zone a form leaves for a stamp. It is lighter than any paper so the orange stamp holds 3:1 contrast on every copy.

### Named Rules
**The One Stamp Rule.** `#FF4F1A` appears only as the settlement stamp and the isotipo's center square. A failed or expired negotiation is stamped in carbon, never orange.

**The Two Inks Rule.** On paper, green means printed by the form and carbon means typed by a party. A value is never green; a label is never carbon.

**The Paper Stock Rule.** Copy identity is carried by paper color (white buyer, canary seller, pink chain), never by an accent stripe or a colored badge.

## Typography

**Display Font:** Archivo, variable with width axis (loaded via `next/font/google`, `axes: ["wdth"]`), fallback `sans-serif`
**Body Font:** Archivo at width 100%
**Label/Mono Font:** Courier Prime 400 and 700, fallback `monospace`

**Character:** Archivo stretched to 118-125% width is the letterpress of a form header: wide, heavy, slightly bureaucratic. Courier Prime is the carbon typewriter, honest and uneven next to it.

All numbers on the page render with `font-variant-numeric: tabular-nums lining-nums slashed-zero` (set on `body`).

### Hierarchy
- **Display** (Archivo 800, width 118%, clamp(56px, 7vw, 96px), line-height 0.86, -0.04em): the payment figure. The fee figure goes larger, clamp(72px, 8.4vw, 124px).
- **Headline** (Archivo 800, width 118%, clamp(30px, 4.3vw, 62px), line-height 0.95, -0.034em, max 24ch, balanced): the hook, printed as the form title. 33px under 640px.
- **Section** (Archivo 800, width 122%, clamp(28px, 3.3vw, 46px), line-height 1, -0.03em): section headings, in desk text on the desk.
- **Form header** (Archivo 800, width 125%, 18 to 44px, -0.01 to -0.03em): wordmark 22px (19px in the nav), order number 30px (26px on phones), record number 44px, document titles 18px, mechanism names 22px, row numbers 16 to 22px.
- **Title** (Archivo 650, width 100%, 23px, line-height 1.22, -0.012em, max 30ch): the purpose line under the hook. 20px on phones.
- **Body** (Archivo 400, 16px, line-height 1.5): base text. Lede 17px at 52ch; paper prose 14.5px at line-height 1.55, 62 to 72ch; small notes 13px.
- **Label** (Archivo 500, width 100%, 12px, line-height 1.25, +0.01em, sentence case, `print-text`): every field label and column head. 13px under 640px.
- **Typed** (Courier Prime 400, 15px, line-height 1.35, `carbon`): values in fields and tables. 13px for links, ledgers, commands and status lines; 16px in the round table; 22px bold for typed figures (amounts, prices); 20px for the signature line.
- **Stamp** (Archivo width 125%): word 800 at 20px uppercase +0.06em, figure 900 at 44px -0.02em, unit line 700 at 20px width 100%.

### Named Rules
**The Typewriter Rule.** Courier Prime is used only for data typed onto a form: values, hashes, addresses, commands, links to transactions. Headings and labels are never set in it.

**The Width Axis Rule.** Width encodes rank. 125% for printed headers and numbers, 112-122% for tabs, buttons and headings, 100% for reading text and labels.

## Layout

The page is a desk with documents laid on it. The hero set spans `min(1270px, 88vw)`; later sections sit in `min(1180px, 100% - 32px)` with 96px between them (64px under 640px). Inside a sheet, padding is 22px top and clamp(18px, 2.8vw, 40px) at the sides; documents use clamp(20px, 3vw, 40px).

The fanned set reserves 46px right and 64px bottom for the copies behind. The second copy sits at translate(18px, 12px) rotate(1.1deg), the third at translate(38px, 22px) rotate(2.3deg). On phones these shrink to 10px and 22px of reserve and rotations of 0.35deg and 0.7deg. The front copy sets the height and the copies behind take its size, showing only their paper edge.

Forms are ruled grids. Field strips use fractional columns (hero strip 1.7fr 1.25fr 1.35fr 1.2fr 1.2fr) separated by 1px vertical rules, and collapse to 3, then 2, then 1 columns. Spacing is tight inside boxes (2 to 8px between label and value) and wide between documents (48 to 96px), a ratio above 1:20.

Breakpoints observed: 1100px (strips to 3 columns, hero body to 1 column), 860px (tables become stacked rows, two-column blocks stack), 767px (the settlement and stamp move above the round table), 640px (phone layout; tabs become sticky on the desk), 359px (tab and nav icons hide or labels go visually hidden). The page must work at 390px.

## Elevation & Depth

Depth is physical: paper resting on a desk. There is one shadow, used only on paper sheets and documents, plus grain textures that give both the desk and the paper a surface. Nothing else floats.

### Shadow Vocabulary
- **Paper on desk** (`box-shadow: 0 1px 1px oklch(22% 0.03 250 / 0.4), 0 18px 40px -14px oklch(18% 0.03 250 / 0.7)`): every `.paper` element. Tinted with the desk hue, never neutral black.

### Textures
- **Desk grain**: SVG fractal noise (baseFrequency 0.85, 2 octaves, 180px tile) blended `soft-light` over the desk.
- **Paper grain**: the same noise at 0.38 opacity, `multiply`, on every sheet.
- **Stamp speckle**: a second noise (baseFrequency 0.7, 3 octaves, 220px tile) used as a mask on the stamp so the ink breaks up like rubber.

### Named Rules
**The One Shadow Rule.** Only paper casts a shadow. Buttons, tabs, stamps and boxes are flat on the sheet.

## Shapes

Every corner is square (0px). The only round shape is the radio dot of the lens selector (50%). Rules carry the structure: 2px `print` under a form header or document top, 1.5px `print` under table heads, 1px `line` between fields and rows, 1px `line-soft` in dense ledgers. Filing tabs are trapezoids cut with `clip-path: polygon(9px 0, calc(100% - 9px) 0, 100% 100%, 0 100%)`. Payment stubs are joined by a perforation of 1.6px desk-colored dots every 10px. Stamps sit rotated (-6deg on the copy, -5deg in the record, -4deg for the VOID mark).

## Components

### Cruce Isotipo (brand mark)
Two asymmetric crossing lines with square caps and a small orange square where they cross. Exact geometry on a 64 by 64 viewBox: line from (8, 52) to (56, 20), line from (8, 16) to (56, 44), stroke 6.5 in `currentColor`, `stroke-linecap: square`. A cut-out square at (31.3, 27.3) of 11 by 11 filled with the ground color it is printed on, then the orange square at (32.8, 28.8) of 8 by 8 in `#ff4f1a`. Shown at 30px in the nav (with the wordmark "Sealed", Archivo 800 at width 125%, 19px) and at 38px as the printer's logo in each form header, where the cut-out takes that copy's paper color. The favicon is a legibility variant: stroke 7.5, cut-out 13, orange square 9, lines `#151617` on `#f2f2ee`.

### Copies and filing tabs
- **Sheet:** a paper element in one of the three stocks, square, with paper grain and the paper shadow.
- **Tabs:** trapezoid filing tabs in the paper color of their copy, Archivo 600 at width 112%, 14.5px, `print-deep`, 40px tall, each with a Phosphor Light icon. Rest state: translateY(5px), opacity 0.86. Hover: translateY(2px), opacity 0.95. Selected: translateY(1px), opacity 1. Press: translateY(3px) scale(0.98). Focus: 2px carbon outline drawn inside the tab (offset -6px), because the clip-path would cut an outside ring.
- **Switching:** the chosen copy comes to the front with a 240ms transform on the movement easing.

### Form fields
- **Field box:** a 12px green label above a typed carbon value, padding 6px 12px 8px 14px, separated from its neighbor by a 1px `line` rule. The first box in a strip has no left rule or padding.
- **Checkbox:** 18px square, 1.5px `print` border, typed checkmark in carbon (stroke 2.2, square caps) that draws in over 240ms.
- **Radio (lens selector):** 20px circle, 1.5px `print` border, 10px carbon dot that scales in from 0.5 over 160ms.

### Security crosshatch
The pattern pre-printed over a field a copy must not receive. A box of at least 84px (56px on phones) filled with 26% `print` over the paper, crossed by two repeating 45deg and -45deg hatches of 1.3px lines on a 3.2px pitch at 80% `print`, opacity 0.94. Any text beneath is blurred 1.6px. It replaces the hidden number; it never sits next to it.

### Rubber stamp
- **Settled:** inside a dashed 1px `line` clear zone in `stamp-ground`. Orange 3.5px border plus a 1.5px orange outline offset 3px, three lines (word, figure, unit) per the Stamp type role, rotated -6deg, `mix-blend-mode: multiply`, masked with the speckle texture.
- **Expired:** the same stamp in carbon.
- **Landing:** from opacity 0, rotate(-4deg) scale(1.08) to rotate(-6deg) scale(1) in 230ms.
- **VOID mark:** a small carbon stamp (2px border, Archivo 800 at width 112%, 13px) rotated -4deg on a voided payment stub, whose amount is struck through.

### Ledger rows
Ruled tables with no zebra striping or cards. Head cells are labels (12px, `print-text`) over a 1.5px `print` rule; body cells are typed carbon over 1px `line` or `line-soft` rules. Row numbers are Archivo 800 at width 125%. Right-aligned money columns. The current replay step is marked with an 8% carbon tint across the row. Under 860px tables become stacked rows with inline labels.

### Payment stubs
Four ruled stubs in a row (two on phones), sharing borders, joined by perforations, with a typed endpoint, a 22px typed amount and a state line with a Light icon.

### Buttons
- **Primary (Replay):** carbon fill, paper-white text, square, 56px tall, minimum 290px wide (full width on phones). A 34px outlined icon box on the left, then a two-line label: 18px Archivo 700 at width 112% over a 13px subline at 0.88 opacity. Hover opacity 0.92, press scale(0.97) at 140ms, focus 2px carbon outline offset 3px.
- **Secondary text action (Check it yourself):** Archivo 650 16px in `print-deep`, underline in `line` color offset 4px, 44px tall, with a Light icon. Hover darkens the underline to `print-deep`.
- **Copy:** 1.5px `print-deep` outline, transparent, 34px tall, Archivo 650 13px. Hover adds a 14% `print` tint; copied state fills `print-deep` with paper-white text; press scale(0.97).

### Command block
A typed `pre` in Courier Prime 13px, line-height 1.6, -0.015em, inside a 1px `line` box tinted with 7% `print`, padding 10px 12px, scrolling horizontally rather than wrapping, with the Copy button below.

### Links
- **On paper:** typed in carbon Courier Prime, underline at 45% carbon, full carbon on hover, followed by a Phosphor Light `ArrowUpRight` at 1em and a visually hidden "(opens in a new tab)". Long hashes wrap anywhere.
- **On the desk:** nav links in Archivo 500 14.5px `on-desk-2`, 36px tall, underlined and brightened to `on-desk` on hover. Footer links in `on-desk` with a 45% underline.

### Navigation
A single row on the desk: isotipo and wordmark on the left, section links on the right with 4px gaps. Optional links hide under 760px. A skip link sits off-screen until focused.

### Motion
Entrance: nav, tabs and set rise from translateY(6px) and opacity 0 in 260ms, staggered by 60ms. Replay types each value by opacity at 90ms per character and draws checkmarks. Interface easing `cubic-bezier(0.23, 1, 0.32, 1)`; sheet movement `cubic-bezier(0.77, 0, 0.175, 1)`. Durations stay between 90 and 260ms and only `transform`, `opacity` and `stroke-dashoffset` animate. Under `prefers-reduced-motion: reduce` every animation and transition is removed and the final state paints.

## Do's and Don'ts

### Do:
- **Do** keep `#ff4f1a` to the settlement stamp and the isotipo square, and stamp failed outcomes in carbon.
- **Do** type every value, hash, address and amount in Courier Prime carbon, and print every label in Archivo 500 12px `print-text`.
- **Do** separate data with 1px `line` rules and 2px `print` header rules inside a ruled grid.
- **Do** hide what a copy must not know behind the security crosshatch, in place of the value.
- **Do** keep every corner square (0px); the lens radio dot is the only circle.
- **Do** use Phosphor icons at weight Light, sized 1em to 1.1em, `aria-hidden`, next to their text.
- **Do** keep tabular, lining, slashed-zero numerals on every number.
- **Do** keep motion under 300ms on `transform` and `opacity`, with reduced motion painting the final state.

### Don't:
- **Don't** use orange for text, links, buttons, highlights, charts or any second stamp.
- **Don't** use emoji anywhere, in UI, copy, captures or video.
- **Don't** use rounded corners, pill shapes or card radii.
- **Don't** add shadows to anything other than a paper sheet, and never use untinted black shadows.
- **Don't** mark a row or copy with a colored accent stripe; copy identity is the paper stock and row emphasis is the 8% carbon tint.
- **Don't** set headings or labels in Courier Prime, or typed values in Archivo.
- **Don't** introduce gradients, glass, glow or neon; the only gradient is the desk's radial lift.
- **Don't** turn steps into a vertical stack of equal cards; use ruled table rows or numbered clauses.
