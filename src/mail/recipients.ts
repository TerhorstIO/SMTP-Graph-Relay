export interface DeliveryLists {
    to: string[];
    cc: string[];
    bcc: string[];
}

export function selectRecipients(envelope: string[], toHeader: string[], ccHeader: string[]): DeliveryLists {
    const envelopeAddresses: string[] = [];
    const envelopeKeys = new Set<string>();
    for (const address of envelope) {
        const cleaned = address.trim();
        const key = cleaned.toLowerCase();
        if (!cleaned || envelopeKeys.has(key)) {
            continue;
        }
        envelopeKeys.add(key);
        envelopeAddresses.push(cleaned);
    }

    const used = new Set<string>();
    const pick = (addresses: string[]): string[] => {
        const selected: string[] = [];
        for (const address of addresses) {
            const cleaned = address.trim();
            const key = cleaned.toLowerCase();
            if (!cleaned || !envelopeKeys.has(key) || used.has(key)) {
                continue;
            }
            used.add(key);
            selected.push(cleaned);
        }
        return selected;
    };

    let to = pick(toHeader);
    const cc = pick(ccHeader);
    const bcc = envelopeAddresses.filter((address) => !used.has(address.toLowerCase()));

    if (to.length === 0 && cc.length === 0) {
        return { to: envelopeAddresses, cc: [], bcc: [] };
    }
    if (to.length === 0) {
        const moved = bcc.shift() || cc.shift();
        if (moved) {
            to = [moved];
        }
    }
    return { to, cc, bcc };
}
