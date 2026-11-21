export interface CharacterSummary {
    id: number;
    name: string;
    classId: number | null;
    className: string | null;
    level: number;
}

export interface CharacterListBody {
    characters: CharacterSummary[];
    limit: number;
}

export interface CharacterRow {
    id: number;
    name: string;
    classId: number | null;
    /** "Level 3 Mage", or "Level 3" for a character without a class. */
    label: string;
}

export function characterListView(data: CharacterListBody): { rows: CharacterRow[]; canCreate: boolean; opensOnCreate: boolean } {
    const rows = (data.characters ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        classId: c.classId ?? null,
        label: `Level ${Number(c.level) || 1}${c.className ? ` ${c.className}` : ''}`,
    }));
    return { rows, canCreate: rows.length < data.limit, opensOnCreate: rows.length === 0 };
}
