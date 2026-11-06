// The sign-up form's values, kept for this tab only so "Resend the link" on the check-email page sends the same
// name and organization again. Nothing here is secret; it never leaves the browser except in that request.
const KEY = "paynp-signup";

export interface SignupDraft {
  name: string;
  email: string;
  org: string;
}

export function rememberSignup(d: SignupDraft) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* resend falls back to a plain sign-in link */
  }
}

export function signupFor(email: string): SignupDraft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as SignupDraft | null;
    return d && d.email === email ? d : null;
  } catch {
    return null;
  }
}

export function forgetSignup() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
