// The COR Shop page object as an agent left it. cor:000001 is the first entry the golden case issues (the sort select).
export class InventoryPage {
  constructor(page) { this.page = page; }
  // COR cor:000001 · 79 Good · 1 match
  sort = () => this.page.getByLabel('Sort');
  // COR cor:000001 · copied onto another locator
  cartLink = () => this.page.locator('#cart-link');
}
