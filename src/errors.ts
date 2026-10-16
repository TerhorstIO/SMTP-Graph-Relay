export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    return String(error);
}

export function clip(value: string, max = 4000): string {
    if (value.length <= max) {
        return value;
    }
    return value.slice(0, max);
}
