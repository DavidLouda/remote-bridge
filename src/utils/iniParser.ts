/**
 * Parses a simple INI file into a nested record of sections → key/value pairs.
 * Lines starting with `;` or `#` are treated as comments.
 *
 * Defensive caps: a single oversized or pathological INI file (e.g. a fuzzed
 * config) cannot exhaust memory — the parser stops accepting new sections /
 * keys past the limits below and returns whatever has been collected so far.
 */
const MAX_SECTIONS = 5_000;
const MAX_KEYS_PER_SECTION = 5_000;
const MAX_LINE_LENGTH = 64 * 1024;

export function parseIni(content: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let currentSection = '';
    let sectionCount = 0;

    for (const line of content.split(/\r?\n/)) {
        if (line.length > MAX_LINE_LENGTH) { continue; }
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
            continue;
        }

        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            if (!sections[currentSection]) {
                if (sectionCount >= MAX_SECTIONS) {
                    // Skip further new sections once the cap is hit.
                    currentSection = '';
                    continue;
                }
                sections[currentSection] = {};
                sectionCount++;
            }
            continue;
        }

        const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
        if (kvMatch && currentSection) {
            const bucket = sections[currentSection];
            if (Object.keys(bucket).length >= MAX_KEYS_PER_SECTION) { continue; }
            bucket[kvMatch[1].trim()] = kvMatch[2].trim();
        }
    }

    return sections;
}
