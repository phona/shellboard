/**
 * Session codenames for auto-naming: adjective-noun pairs from fixed
 * wordlists (400 combinations). Memorable, unique per project, no numbers
 * unless the pool of free names runs dry.
 */

const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "clear",
  "crisp",
  "dense",
  "even",
  "firm",
  "fluent",
  "keen",
  "level",
  "quiet",
  "solid",
  "steady",
  "stark",
  "swift",
  "terse",
  "tight",
  "vivid",
  "warm",
] as const;

const NOUNS = [
  "atlas",
  "cedar",
  "cinder",
  "comet",
  "cove",
  "delta",
  "ember",
  "falcon",
  "granite",
  "harbor",
  "juniper",
  "ledge",
  "mesa",
  "nebula",
  "orbit",
  "pine",
  "quartz",
  "ridge",
  "slate",
  "summit",
] as const;

function pick(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? "delta";
}

export function codename(taken: ReadonlySet<string>): string {
  let candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  for (let attempt = 0; attempt < 24 && taken.has(candidate); attempt++) {
    candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  }
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  while (taken.has(`${candidate}-${n}`)) n++;
  return `${candidate}-${n}`;
}
