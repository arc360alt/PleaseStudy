import {
  CLASSIC_SETTINGS,
  PARTIAL_HINT,
  PARTIAL_OPTIONS,
  STUDY_SETTINGS,
  type PartialCredit,
  type StudySettings,
} from "../api";
import { Toggle } from "./Modal";

// Presets ignore partial credit, which is chosen separately.
const same = (a: StudySettings, b: StudySettings) =>
  (Object.keys(a) as (keyof StudySettings)[]).every((k) => k === "multi_partial" || a[k] === b[k]);

/** Classic / Study presets plus the individual switches behind them. */
export default function StudyOptions({
  value,
  onChange,
  autoAdvance,
  onAutoAdvance,
  hidePartial,
}: {
  hidePartial?: boolean;
  value: StudySettings;
  onChange: (s: StudySettings) => void;
  autoAdvance?: boolean;
  onAutoAdvance?: (v: boolean) => void;
}) {
  const set = (patch: Partial<StudySettings>) => onChange({ ...value, ...patch });
  const preset = same(value, CLASSIC_SETTINGS) ? "classic" : same(value, STUDY_SETTINGS) ? "study" : "custom";
  return (
    <div className="study-options">
      <div className="seg seg-full seg-tall">
        <button
          type="button"
          className={preset === "classic" ? "on" : ""}
          onClick={() => {
            onChange({ ...CLASSIC_SETTINGS, multi_partial: value.multi_partial });
            onAutoAdvance?.(true);
          }}
        >
          <strong>Classic</strong>
          <small>Race the clock for points</small>
        </button>
        <button
          type="button"
          className={preset === "study" ? "on" : ""}
          onClick={() => {
            onChange({ ...STUDY_SETTINGS, multi_partial: value.multi_partial });
            onAutoAdvance?.(false);
          }}
        >
          <strong>Study mode</strong>
          <small>No timer, repeat misses until you get them</small>
        </button>
      </div>
      <Toggle checked={value.timer} onChange={(timer) => set({ timer })} label="Timer" hint="Off = take as long as you need" />
      <Toggle
        checked={value.repeat_wrong}
        onChange={(repeat_wrong) => set({ repeat_wrong })}
        label="Repeat questions I get wrong"
        hint="Missed ones come back at the end until you get them right"
      />
      <Toggle
        checked={value.read_countdown}
        onChange={(read_countdown) => set({ read_countdown })}
        label="Read-the-question countdown"
        hint="Show the question alone before the answers appear"
      />
      <Toggle
        checked={value.shuffle_questions}
        onChange={(shuffle_questions) => set({ shuffle_questions })}
        label="Shuffle question order"
      />
      <Toggle
        checked={value.shuffle_answers}
        onChange={(shuffle_answers) => set({ shuffle_answers })}
        label="Shuffle answer order"
        hint="So you learn the answer, not its position"
      />
      {!hidePartial && (
        <PartialCreditField value={value.multi_partial} onChange={(multi_partial) => set({ multi_partial })} />
      )}
      {onAutoAdvance && (
        <Toggle
          checked={!!autoAdvance}
          onChange={onAutoAdvance}
          label="Auto-advance"
          hint="Move on by itself after showing the answer"
        />
      )}
    </div>
  );
}

export function PartialCreditField({
  value,
  onChange,
}: {
  value: PartialCredit;
  onChange: (v: PartialCredit) => void;
}) {
  return (
    <label className="field partial-field">
      <span>Partly-right “pick several” answers</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as PartialCredit)}>
        {PARTIAL_OPTIONS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <small className="muted">{PARTIAL_HINT}</small>
    </label>
  );
}

export function describeSettings(s: StudySettings): string[] {
  const out: string[] = [];
  out.push(s.timer ? "Timed" : "No timer");
  if (s.multi_partial === "at_least_half") out.push("Half credit at ≥ half right");
  if (s.multi_partial === "more_than_half") out.push("Half credit at > half right");
  if (s.repeat_wrong) out.push("Missed questions repeat");
  if (s.shuffle_questions) out.push("Shuffled questions");
  if (s.shuffle_answers) out.push("Shuffled answers");
  return out;
}
