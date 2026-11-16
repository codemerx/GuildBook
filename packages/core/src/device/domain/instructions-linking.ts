// Linking instructions per company (PLAN.md §3.12 "Linking and unlinking instructions"): on each device, a company's
// instructions are linked or not. Every linked company's rules apply in every session, so only one company is linked
// by default, and linking a second one is the user's choice after a warning. Main keeps the choice in device.json.

/** What the rules need of an instance. */
export interface LinkableInstance {
  readonly id: string;
  readonly name: string;
  readonly instructionsLinked: boolean;
  readonly status: string;
}

/**
 * The answers of the Instructions page: [Link] (refused with the warning while another company is linked), [Link
 * anyway], [Unlink Acme's and link Globex's] and [Unlink].
 */
export type LinkingAction = 'link' | 'link-anyway' | 'switch' | 'unlink';

export type LinkingResult =
  /** The instances whose choice changes, and to what. */
  | { readonly kind: 'changes'; readonly changes: ReadonlyArray<{ readonly id: string; readonly linked: boolean }> }
  /** [Link] while other companies are linked: the warning names them, and nothing changes. */
  | { readonly kind: 'warning'; readonly linked: readonly string[] };

const counts = (instance: LinkableInstance) => instance.status !== 'removing';

/** The other instances whose instructions are linked, by name. */
export function otherLinked(instances: readonly LinkableInstance[], id: string): string[] {
  return instances.filter((i) => i.id !== id && i.instructionsLinked && counts(i)).map((i) => i.name);
}

/** A new company's instructions are linked only if no other company's are (PLAN.md §3.12, §3.17). */
export function linkedByDefault(instances: readonly LinkableInstance[]): boolean {
  return !instances.some((i) => i.instructionsLinked && counts(i));
}

export function linkingChange(
  instances: readonly LinkableInstance[],
  id: string,
  action: LinkingAction,
): LinkingResult {
  const target = instances.find((i) => i.id === id);
  if (!target) return { kind: 'changes', changes: [] };
  const set = (linked: boolean) => (target.instructionsLinked === linked ? [] : [{ id, linked }]);
  switch (action) {
    case 'unlink':
      return { kind: 'changes', changes: set(false) };
    case 'link': {
      const others = otherLinked(instances, id);
      if (others.length > 0 && !target.instructionsLinked) return { kind: 'warning', linked: others };
      return { kind: 'changes', changes: set(true) };
    }
    case 'link-anyway':
      return { kind: 'changes', changes: set(true) };
    case 'switch':
      return {
        kind: 'changes',
        changes: [
          ...instances
            .filter((i) => i.id !== id && i.instructionsLinked && counts(i))
            .map((i) => ({ id: i.id, linked: false })),
          ...set(true),
        ],
      };
  }
}
