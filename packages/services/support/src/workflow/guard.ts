
const ORDER_MARKERS: RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.]*\b(instructions?|guidelines|note above)\b/,
  /\boverride\b/,
  /^\s*system\s*:/m,
  /\[admin\]/,
  /\bnote to the model\b/,
  /\bif you are an ai\b/,
  /\brespond only with\b/,
  /\bpre-approved\b/,
  /\b(label|mark)\b[^.]*\bclean\b/,
  /\b(action|output)\b[^.]*\bclean\b/,
];


export function givesOrders(note: string): boolean {
  const text = note.toLowerCase();
  return ORDER_MARKERS.some((re) => re.test(text));
}