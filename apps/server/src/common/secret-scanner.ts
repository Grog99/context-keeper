/**
 * Skaner sekretów przy save (§10 tech-stack, FR-S1). Wąski, wysokosygnałowy zestaw wzorców —
 * private keys, klucze chmur (AWS/GCP), JWT, pola password=/passwd=/secret=, oraz entropia Shannona
 * dla długich losowych stringów. Agent-save → blokada (sekret nigdy nie dotyka bazy).
 *
 * Bez redakcji w locie (decyzja produktowa, §10): redakcja to słabsza gwarancja + cicha mutacja
 * treści agenta. Tu tylko DETEKCJA — wołanie zwraca typ trafienia, nigdy dopasowany materiał.
 */

export type SecretKind =
  | 'private_key'
  | 'aws_access_key'
  | 'gcp_api_key'
  | 'jwt'
  | 'password_field'
  | 'high_entropy';

export interface SecretHit {
  kind: SecretKind;
}

const PRIVATE_KEY_RE = /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----/;
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;
const GCP_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/;
// JWT: trzy segmenty base64url oddzielone kropkami; wymagamy sensownej długości każdego segmentu,
// żeby nie łapać przypadkowych "a.b.c" w prozie/kodzie.
const JWT_RE = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
// password=/passwd=/secret= z wartością (bez samego słowa w prozie, wymagany znak przypisania).
// Bez wiodącego \b — "DB_PASSWD:" też ma trafiać (podkreślnik jest \w, więc \b by tam nie zadziałał).
const PASSWORD_FIELD_RE = /(password|passwd|secret)\s*[:=]\s*["']?[^\s"'<>]{6,}/i;

// Kandydaci na wysoką entropię: długie ciągi znaków typowych dla base64/tokenów.
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/_-]{24,}/g;
const HEX_ONLY_RE = /^[0-9a-fA-F]+$/;
const DECIMAL_ONLY_RE = /^[0-9]+$/;
// Próg dobrany tak, by legalne hexy (SHA/UUID, max ~4 bity/znak) i identyfikatory dev
// (powtarzające się znaki, słowa) przechodziły, a losowe sekrety (base64/base62, ~5.5-6 bitów/znak) — nie.
const ENTROPY_THRESHOLD = 4.3;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasHighEntropyToken(text: string): boolean {
  for (const match of text.matchAll(ENTROPY_CANDIDATE_RE)) {
    const candidate = match[0];
    // Hexy (hashe, uuidy) i ciągi czysto dziesiętne są częste w treści dev — nie traktujemy ich
    // jako sekret niezależnie od entropii (ich max entropia i tak jest poniżej progu, ale to
    // dodatkowa asekuracja czytelności reguły).
    if (HEX_ONLY_RE.test(candidate) || DECIMAL_ONLY_RE.test(candidate)) continue;
    if (shannonEntropy(candidate) >= ENTROPY_THRESHOLD) return true;
  }
  return false;
}

/** Zwraca pierwsze trafienie (typ sekretu) albo null jeśli tekst wygląda czysto. */
export function scanForSecrets(text: string): SecretHit | null {
  if (PRIVATE_KEY_RE.test(text)) return { kind: 'private_key' };
  if (AWS_ACCESS_KEY_RE.test(text)) return { kind: 'aws_access_key' };
  if (GCP_API_KEY_RE.test(text)) return { kind: 'gcp_api_key' };
  if (JWT_RE.test(text)) return { kind: 'jwt' };
  if (PASSWORD_FIELD_RE.test(text)) return { kind: 'password_field' };
  if (hasHighEntropyToken(text)) return { kind: 'high_entropy' };
  return null;
}
