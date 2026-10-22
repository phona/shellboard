import { useEffect, useRef, useState } from "react";
import {
  firstEnvError,
  parseEnvText,
  serializeEnvPairs,
  validateEnvKey,
  type EnvPair,
} from "../state/env";

/** Key/value rows for a launch environment (D9). Keys are validated inline with
    the same rules the server enforces; values are never rewritten — they are
    the user's data.

Two modes over the same state: rows for one-off edits, bulk for pasting a
`.env` block or an `env` dump. Bulk text is the only place a whole environment
can be replaced in one gesture; it parses on every keystroke and pushes the
result up.

A bulk line that is not an assignment (no `=`) is *not* representable as a pair
without loss, so the editor reports its own validity through `onValidityChange`
and the parent keeps Save disabled until the text parses. Deriving that from the
pairs alone would let a single-token orphan line (`b`) look like a valid empty
variable and silently drop the rest of the value. */
export function EnvEditor({
  pairs,
  onChange,
  namePrefix,
  onValidityChange,
}: {
  pairs: EnvPair[];
  onChange: (pairs: EnvPair[]) => void;
  namePrefix: string;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [mode, setMode] = useState<"rows" | "bulk">("rows");
  const [text, setText] = useState(() => serializeEnvPairs(pairs));
  // The last value this editor pushed up. Anything else arriving through
  // `pairs` is an external change (e.g. another preset picked in the dialog)
  // and must rewrite the bulk text.
  const pushed = useRef(pairs);

  useEffect(() => {
    if (pushed.current === pairs) return;
    pushed.current = pairs;
    setText(serializeEnvPairs(pairs));
  }, [pairs]);

  const applyText = (value: string) => {
    setText(value);
    const parsed = parseEnvText(value);
    pushed.current = parsed.pairs;
    onChange(parsed.pairs);
  };

  const setPair = (index: number, patch: Partial<EnvPair>) => {
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  };

  const blocking = firstEnvError(pairs);
  const bulk = mode === "bulk" ? parseEnvText(text) : null;
  const valid = blocking === null && (bulk === null || bulk.errors.length === 0);

  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  return (
    <div className="env-editor">
      <div className="env-modes">
        <button
          type="button"
          className={mode === "rows" ? "env-mode selected" : "env-mode"}
          aria-pressed={mode === "rows"}
          onClick={() => setMode("rows")}
        >
          Rows
        </button>
        <button
          type="button"
          className={mode === "bulk" ? "env-mode selected" : "env-mode"}
          aria-pressed={mode === "bulk"}
          onClick={() => {
            setText(serializeEnvPairs(pairs));
            setMode("bulk");
          }}
        >
          Bulk
        </button>
      </div>

      {mode === "bulk" ? (
        <>
          <textarea
            className="env-bulk"
            value={text}
            onChange={(event) => applyText(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            rows={Math.min(12, Math.max(4, text.split("\n").length + 1))}
            aria-label="Environment variables, one KEY=value per line"
            placeholder={"ANTHROPIC_MODEL=sonnet\nANTHROPIC_BASE_URL=https://…"}
          />
          <div className="env-hint">
            one <code>KEY=value</code> per line · <code>#</code> comments and blank lines ignored ·
            quotes and a leading <code>export</code> are stripped
          </div>
          {bulk &&
            bulk.errors.map((error) => (
              <div className="form-error" key={error}>
                {error}
              </div>
            ))}
        </>
      ) : (
        <>
          {pairs.map((pair, index) => {
            const error = validateEnvKey(pair.key);
            return (
              <div className="env-row" key={`${namePrefix}-${index}`}>
                <input
                  className="env-key"
                  value={pair.key}
                  onChange={(event) => setPair(index, { key: event.target.value })}
                  placeholder="ANTHROPIC_MODEL"
                  aria-label={`Environment variable name ${index + 1}`}
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  className="env-value"
                  value={pair.value}
                  onChange={(event) => setPair(index, { value: event.target.value })}
                  placeholder="value"
                  aria-label={`Environment variable value ${index + 1}`}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove variable ${pair.key || index + 1}`}
                  onClick={() => onChange(pairs.filter((_, i) => i !== index))}
                >
                  ×
                </button>
                {error && <div className="env-row-error">{error}</div>}
              </div>
            );
          })}
          <button
            type="button"
            className="btn"
            onClick={() => onChange([...pairs, { key: "", value: "" }])}
          >
            Add variable
          </button>
        </>
      )}
      {blocking && <div className="form-error">{blocking}</div>}
    </div>
  );
}
