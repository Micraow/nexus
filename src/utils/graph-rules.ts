import type { ConceptRelation } from '@/types/domain'

/**
 * True when adding parent→child would close a directed cycle in the
 * hierarchy graph. Related edges are ignored; proposed edges still count so a
 * confirmed relation cannot silently close a loop left open by proposals.
 */
export function wouldCreateHierarchyCycle(parentId: string, childId: string, relations: ConceptRelation[]): boolean {
  if (parentId === childId) return true
  const children = new Map<string, string[]>()
  relations
    .filter((relation) => relation.relationType === 'hierarchy' && relation.status !== 'rejected')
    .forEach((relation) => {
      const current = children.get(relation.parentConceptId) ?? []
      current.push(relation.childConceptId)
      children.set(relation.parentConceptId, current)
    })
  const stack = [childId]
  const visited = new Set<string>()
  while (stack.length) {
    const current = stack.pop() as string
    if (current === parentId) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(children.get(current) ?? []))
  }
  return false
}
