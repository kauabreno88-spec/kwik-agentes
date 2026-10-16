// Borda do servidor: só endereços locais (localhost, *.localhost, IPs) ou os de KWIK_ALLOWED_HOSTS.
// Protege contra DNS rebinding (um site qualquer apontando um nome para 127.0.0.1) e contra POST de outra origem.

/** O cabeçalho Host é de um endereço local (ou liberado)? */
export function hostAllowed(hostHeader, allowed = new Set()) {
  if (!hostHeader) return false;
  let host = String(hostHeader).toLowerCase().trim();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  if (host === 'host.docker.internal') return true;
  return allowed.has(host);
}

/** O cabeçalho Origin (quando existe) é local? Os hooks não mandam Origin. */
export function originAllowed(origin, allowed = new Set()) {
  if (!origin) return true;
  try {
    return hostAllowed(new URL(origin).host, allowed);
  } catch {
    return false;
  }
}
