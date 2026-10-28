import { BACKFILL_MAX, BACKFILL_UNITS, type BackfillPeriod, type BackfillUnit } from '@bio-majesty/shared';
import { Input, Select } from '../../components/ui';

/** What the user is typing: the amount stays a string so the box can be empty mid-edit. */
export interface PeriodDraft {
  amount: string;
  unit: BackfillUnit;
}

export const toDraft = (p: BackfillPeriod): PeriodDraft => ({ amount: String(p.amount), unit: p.unit });

/** The period, or null while the amount isn't a whole number within the unit's limit. */
export function toPeriod(d: PeriodDraft): BackfillPeriod | null {
  const amount = Number(d.amount);
  return d.amount.trim() !== '' && Number.isInteger(amount) && amount >= 1 && amount <= BACKFILL_MAX[d.unit] ? { amount, unit: d.unit } : null;
}

/** "How far back": a number plus a unit (days, weeks, months, years), up to about three years. */
export function BackfillPeriodInput({ value, onChange }: { value: PeriodDraft; onChange: (draft: PeriodDraft) => void }) {
  const max = BACKFILL_MAX[value.unit];
  const invalid = !toPeriod(value);
  return (
    <div>
      <div className="flex gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          step={1}
          value={value.amount}
          onChange={(e) => onChange({ ...value, amount: e.target.value })}
          aria-label="How far back"
          aria-invalid={invalid}
          className="w-24"
        />
        <Select value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as BackfillUnit })} aria-label="Unit" className="w-36">
          {BACKFILL_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </Select>
      </div>
      {invalid && (
        <p className="mt-1 text-xs text-critical">
          Enter a whole number from 1 to {max} {value.unit} (a backfill goes back at most 3 years).
        </p>
      )}
    </div>
  );
}
