// Text stays in this tab's memory, never browser persistent/session storage.
// Bound draft retention and clear it when identity changes or signs out.
export class Drafts {
  private readonly values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key) ?? '';
  }
  set(key: string, value: string) {
    this.values.delete(key);
    if (value) this.values.set(key, value.slice(0, 8000));
    while (this.values.size > 20)
      this.values.delete(this.values.keys().next().value!);
  }
  clear() {
    this.values.clear();
  }
  remove(key: string) {
    this.values.delete(key);
  }
}
