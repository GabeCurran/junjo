// One shared, frozen empty list for hooks to return while they have no
// data, so the value keeps its identity across renders. `never[]`
// assigns to any list type without letting a caller add to it.
export const EMPTY_LIST: never[] = Object.freeze([]) as never[];
