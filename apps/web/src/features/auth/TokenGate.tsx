import { useState } from "react";
import { ApiError, api } from "../../api/client";
import { useUi } from "../../state/store";

export function TokenGate() {
  const authRequired = useUi((state) => state.authRequired);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!authRequired) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api.auth.login(token);
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "login failed");
    }
  };

  return (
    <div className="token-gate">
      <form className="token-card" onSubmit={(event) => void submit(event)}>
        <strong>Shellboard</strong>
        <span className="muted">Enter your access token to continue.</span>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="token"
        />
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn primary">
          Unlock
        </button>
      </form>
    </div>
  );
}
