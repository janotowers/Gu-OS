/**
 * Tools cuyo handler NO escribe su propia fila en tool_calls: el grafo la
 * escribe por ellos. Toda tool fuera de esta lista debe crear y cerrar su
 * propia fila dentro del handler; el grafo NO crea una fila previa (approved)
 * antes de invoke() para ellas, porque eso duplicaba la auditoría en pruebas N3
 * con auto_execute (p. ej. generate_document_from_template aparecía dos veces:
 * executed + deduplicated).
 *
 * El grafo solo escribe filas en el camino de confirmación (riesgo medio/alto):
 * al pedir aprobación, siempre; al autoejecutar (cron con auto-approve o una
 * política), solo para las tools de esta lista. Por eso solo una tool que
 * requiere confirmación puede depender de esta lista: una tool de riesgo bajo se
 * autoejecuta sin pasar por ahí y debe escribir su propia fila.
 *
 * Una invocación lógica = una fila (Slice Plan §8 Q8): cuando una persona
 * aprobó la llamada, la tool que escribe su propia fila toma la fila de
 * confirmación del grafo en vez de crear otra (tool-call-audit.ts).
 *
 * R1 Cycle 3 order 4 (Slice Plan v1.32 §6) añadió las once tools de
 * confirmación de abajo, que no escriben fila propia. Order 5 (§8 Q7) sacó de
 * aquí get_user_preferences y list_enabled_tools: son de riesgo bajo y ahora se
 * auditan solas, como las demás. tool-audit-ownership.selftest.ts sostiene
 * estas reglas contra el código de cada handler.
 */
const TOOLS_WITHOUT_INTERNAL_AUDIT = new Set([
  // Confirmation-path tools whose handlers write no row (order 4).
  "archive_user_memory",
  "delete_user_memory",
  "github_create_repo",
  "github_create_issue",
  "bash",
  "write_file",
  "edit_file",
  "schedule_task",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
]);

export function toolOwnsAuditTrail(toolId: string): boolean {
  return !TOOLS_WITHOUT_INTERNAL_AUDIT.has(toolId);
}
