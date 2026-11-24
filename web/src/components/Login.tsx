import { createSignal, Show } from "solid-js";
import { login, state } from "../store";

const REMEMBER = "ntrader.account";

function remembered() {
  try {
    return localStorage.getItem(REMEMBER) ?? "";
  } catch {
    return "";
  }
}

export function Login() {
  const [account, setAccount] = createSignal(remembered());
  const [password, setPassword] = createSignal("");
  const busy = () => state.status === "connecting";

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const id = Number.parseInt(account(), 10);
    if (!Number.isFinite(id) || !password()) return;
    try {
      // Only the account number is remembered, never the password.
      localStorage.setItem(REMEMBER, String(id));
    } catch {
      /* storage can be unavailable; logging in still works */
    }
    login(id, password());
  };

  return (
    <main class="login">
      <form onSubmit={submit}>
        <h1 class="brand">
          N<span>Trader</span>
        </h1>
        <div class="field">
          <label for="login-account">Account number</label>
          <input id="login-account" class="input num" inputmode="numeric" autocomplete="username" required value={account()} onInput={(e) => setAccount(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" class="input" type="password" autocomplete="current-password" required value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        </div>
        <Show when={state.loginError}>
          <p class="error" role="alert">
            {state.loginError}
          </p>
        </Show>
        <button type="submit" class="btn btn-primary" disabled={busy()}>
          {busy() ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
