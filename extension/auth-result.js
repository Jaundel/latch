// Classify only what the site's rejection establishes, not the likely cause.
export function classifySignInError(message = '', locked = false) {
  const text = message.toLowerCase();
  const credentialError = /incorrect|invalid|wrong|did ?n.?t match|does ?n.?t match|not recogni[sz]ed|not found/.test(text);
  const identity = /e-?mail|user ?name|user ?id|account not found/.test(text);
  const password = /password/.test(text);
  const uncertain = /\b(or|either|may|might|could)\b/.test(text);
  if ((identity && (password || credentialError)) ||
      (uncertain && (password || /lock|disabled|suspended/.test(text)))) {
    return 'credentials_or_account_problem';
  }
  if (locked || /too many (attempts|tries)|account (is )?(locked|disabled|suspended)|temporarily (locked|blocked)/.test(text)) return 'locked';
  if (/no account|not found|does ?n.?t exist|could ?n.?t find|not registered|no user/.test(text)) return 'no_account';
  if (password && credentialError) return 'wrong_password';
  return 'sign_in_failed';
}
