/**
 * Tags of the tagged members of an error union.
 */
export type TagOf<E> = E extends { readonly _tag: infer K extends string } ? K : never

/**
 * Members of an error union with the given tag(s).
 */
export type ByTag<E, K> = Extract<E, { readonly _tag: K }>
