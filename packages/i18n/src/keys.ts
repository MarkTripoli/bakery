import english from "../locales/en.json" with { type: "json" };

export type MessageKey = keyof typeof english;
export const messageKeys = Object.freeze(Object.keys(english) as MessageKey[]);
