# Aida Takeoff

Tender drawings in; quantities and a priced bill of quantities out.

A contractor uploads the PDF drawings for one services package and gets back
the counts of every legend item (luminaires, sockets and switches, detectors,
sprinkler heads, diffusers, sanitary fixtures, equipment) and a bill of
quantities to price. Counts first; lengths and areas (partitions, ceilings,
cable containment) come later.

No drawings are stored in this repository except synthetic fixtures generated
by `scripts/make-fixtures.ts`. Benchmarks and customer files live elsewhere.

## How it counts

1. **Vector text first, deterministically.** Most tender drawings are vector
   PDFs. pdf.js reads every text run with its position; the legend is found
   from its heading and read as `[symbol] [tag] [description]` (row legends
   and table legends with catalogue columns); the title block gives the
   drawing number and scale. Every text run that is exactly a legend tag
   (`A1`, `SD`, or a multiplier form such as `4 NO. A1`) outside the legend,
   title block and notes is one instance. No model is involved, and on tagged
   items this path is exact.
2. **Vector symbols, deterministically.** CAD exports draw each instance of a
   symbol as the same group of paths. The paths inside each legend row's
   symbol cell become a signature (element shapes, sizes and positions
   relative to the glyph, invariant to translation, uniform scale, quarter
   turns and mirroring; hatch strips merged into one fill). Every plan path
   with the anchor's shape is tried as an instance and the rest of the glyph
   must be found around it; the fraction found is the match confidence.
   Conflicts between items over the same paths go to the better and larger
   match, so a two-gang switch drawn as two one-gang glyphs counts once, and
   text inside a match that spells another legend tag rejects it. Still no
   model. This works when the legend and the plan share block definitions;
   a legend sheet drawn at another size with other primitives does not
   transfer.
3. **Vision for what is left.** Items with neither a tag nor a symbol match
   go to the model (`--vision-fallback auto` sends them only on raster sheets
   or when the anchor shape was seen but never matched as a whole; `always`
   and `never` do what they say): each page is rendered, tiled with overlap,
   and Gemini on Vertex AI is shown the legend crop and one tile at a time.
   The model returns boxes and item ids as structured JSON; de-duplication
   across tile overlaps, exclusion of legend and title regions, and counting
   happen in code.
4. **A second look.** Low-confidence and isolated model detections are
   cropped out and shown to the model again next to the legend. A confident
   "none" drops the detection; disagreement flags it `needsReview` in every
   output.

## Command line

```sh
aida-takeoff count <drawing.pdf> [--legend auto|vector|vision|legend.json] \
    [--out result.json] [--xlsx bill.xlsx] [--overlay marked.pdf] \
    [--no-symbols] [--no-vision] [--vision-fallback auto|never|always] \
    [--no-verify] [--cross-check] [--dpi 200] [--tile 1024] \
    [--model gemini-3.8-flash] [--max-spend 2]

aida-takeoff bench <dir> [--json report.json] [--out-dir results/] \
    [--only set-01,set-02] [--no-vision] [--no-verify] [--max-spend 2]
```

During development run the sources directly: `node src/cli.ts count …`
(Node 24 strips the types). After `npm run build` the same command is
`node dist/cli.js`.

Outputs of `count`:

- `result.json` — legend, per-page detections with coordinates (points from
  the top-left corner of the page as displayed), confidence and source
  (`vector` for a tag, `symbol` for a geometry match, `vision` for the
  model), item totals per page, per-item symbol-matching statistics, model
  usage and cost.
- `--xlsx` — a bill of quantities with trade sections (lighting, small power,
  fire detection, sprinklers, air distribution, sanitary, other), one numbered
  item per legend row, `nr` quantities, an empty rate column, amount and total
  formulas, plus "Counts by drawing" and "Detections" sheets for audit.
- `--overlay` — the original drawing with every detection boxed and
  labelled: blue for tags read from the text, purple for symbols matched on
  vector geometry, green for symbols recognised by the model, red for
  anything that needs a check.

## Benchmark harness

```
<dir>/
  set-01/
    drawings/*.pdf
    ground_truth.json      { "items": { "A1": 223, "SD": 114 }, "descriptions": { "A1": "…" } }
  set-02/ …
```

Ground truth must come from the tender's own bill or schedule, never from a
model. `bench` runs the engine on every drawing of every set, sums counts by
tag (falling back to the description), and reports two pass rules per set:

- **strict** — every ground-truth item is within ±5 % of its true count
  (so items under 20 must be exact; a true 0 must be predicted 0). The
  headline "N of M sets" uses this rule.
- **weighted** — the sum of absolute errors divided by the sum of true
  counts is ≤ 5 %; this is what a priced bill feels.

It also reports items the engine found that the ground truth lacks, cost per
set (tokens × Gemini 3.8 Flash list price: $1.50 / $7.50 per million input /
output tokens) and wall time. `--json` writes the full report.

Result on the synthetic fixtures in `tests/fixtures/bench` (three sets, 22
items): 3 of 3 sets pass strict with every item exact on vector text and
vector symbols alone, at no model cost. With symbol matching switched off,
the vision pass reaches the same counts for about $0.29 per set on average.

## Vertex AI access

The vision pass needs Google Cloud credentials at run time and never stores
them: the project comes from `GOOGLE_CLOUD_PROJECT` or `gcloud config
get-value project`, the token from `GOOGLE_OAUTH_ACCESS_TOKEN` or `gcloud
auth application-default print-access-token`. Model responses are cached
under `.tmp/vertex-cache` (override with `AIDA_CACHE_DIR`) so reruns while
iterating cost nothing; a spend cap (`--max-spend`, default $2 per run)
aborts a runaway run. `AIDA_MODEL` overrides the model id.

## Development

Requires Node 24 (`.node-version`, `mise.toml`) and, for page rendering,
`pdftoppm` from poppler (pdf.js with `@napi-rs/canvas` is the fallback).

```sh
npm ci
npm run check      # typecheck, lint (max-warnings 0), tests (no network)
npm run build      # emits dist/
node scripts/make-fixtures.ts   # regenerates tests/fixtures/bench (deterministic)
```

`tests/policy.test.ts` fails the build if any tracked file contains an email
address, a personal or employer name, a cloud project id, a key-shaped
string, or a PDF outside `tests/fixtures/`. CI also runs gitleaks from a
checksum-verified binary over the full history. `tests/fixtures.test.ts`
proves the committed fixture PDFs are byte-identical to a fresh generation.
