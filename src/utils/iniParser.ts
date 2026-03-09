/**
 * Parses a simple INI file into a nested record of sections → key/value pairs.
 * Lines starting with `;` or `#` are treated as comments.
 */
export function parseIni(content: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let currentSection = '';

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
            continue;
        }

        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            if (!sections[currentSection]) {
                sections[currentSection] = {};
            }
            continue;
        }

        const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
        if (kvMatch && currentSection) {
            sections[currentSection][kvMatch[1].trim()] = kvMatch[2].trim();
        }
    }

    return sections;
}
