// Tab search: every word of the query must appear in the tab's title or URL,
// ignoring case and accents ("ecole" finds "École"). Tabs matching in their
// title come first, then the most recently used.

const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export class TabIndex {
    constructor(instances) {
        this._entries = instances.flatMap(instance =>
            instance.snapshot.windows.flatMap(window => window.tabs.map(tab => ({
                instance,
                tab,
                title: fold(tab.title ?? ''),
                url: fold(tab.url ?? ''),
            }))));
    }

    search(query) {
        const words = fold(query).split(/\s+/).filter(Boolean);
        if (words.length === 0)
            return [];
        const matches = [];
        for (const entry of this._entries) {
            let inTitle = 0;
            const all = words.every(word => {
                if (entry.title.includes(word)) {
                    inTitle++;
                    return true;
                }
                return entry.url.includes(word);
            });
            if (all)
                matches.push({instance: entry.instance, tab: entry.tab, inTitle});
        }
        return matches.sort((a, b) =>
            b.inTitle - a.inTitle || (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0));
    }
}
