# Visual design notes

Colors follow a validated data-visualization palette (tokens in `frontend/src/index.css`).

## Surfaces and ink

| Role | Hex |
|---|---|
| Page plane | `#f9f9f7` |
| Chart / card surface | `#fcfcfb` (cards `#ffffff`) |
| Primary ink | `#0b0b0b` |
| Secondary ink | `#52514e` (7.7:1 on the surface) |
| Muted (axis labels) | `#898781` (3.5:1) |
| Gridlines / axis | `#e1e0d9` / `#c3c2b7`, 1px solid |

Text always uses ink tokens; color is carried by a mark beside the text (dot, icon), never by the text itself.

## Sentiment (status colors, never color alone)

Sentiment means good/bad for the share price, so it uses the reserved status colors — always paired with an icon and a label.

| Sentiment | Color | Icon | Chart marker |
|---|---|---|---|
| Positive | `#0ca30c` (good) | trending up | ▲ below the bar |
| Negative | `#d03b3b` (critical, 4.7:1) | trending down | ▼ above the bar |
| Neutral | `#898781` (neutral gray) | minus | ● above the bar |
| Undecided | `#fab219` (warning; sub-3:1 by design, mitigated by icon + label + shape) | question | ■ above the bar |

Price direction uses the same pair: up `#006300` text / `#0ca30c` marks, down `#d03b3b`.

## Categories (categorical palette)

Categories get the eight validated categorical hues in fixed order — never cycled; the 9th+ category uses neutral gray `#898781`:

`#2a78d6` `#eb6834` `#1baf7a` `#eda100` `#e87ba4` `#008300` `#6250d6` `#e34948`

Validator result (light mode, adjacent pairs): lightness band, chroma floor, CVD separation (worst ΔE 9.1) and normal-vision floor (worst ΔE 19.6) pass. Aqua, yellow and magenta sit below 3:1 against the surface, so category chips always show their name (the required relief channel).

## Chart conventions

- Price and volume are separate panes sharing the time axis — never a dual-axis chart.
- Volume bars are a 35% wash of the direction color; unusual-volume days are drawn at full strength.
- Crosshair readout (OHLC + volume) on hover, and a table view of the same candles.
- The hero price uses the UI sans at 44px with proportional figures; tables and axes use tabular figures.
