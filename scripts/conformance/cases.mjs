// One case per idiom-table shape (spec §10): a fixture page, the element to inspect, and what the renderer is expected to say.
// `idioms` are the ones the rendered helper must use; `none` marks a page the renderer must decline.
export const CASES = [
  { id: 'attribute', fixture: 'p3a-attribute.html', target: '[data-testid="sku-beta"] button', idioms: ['item.attribute', 'leaf.aria'], cy: ['item.attribute', 'leaf.css'] },
  { id: 'label', fixture: 'p3a-label.html', target: '.faq:nth-child(2) .faq__q', idioms: ['item.label', 'leaf.css'], cy: ['item.label', 'leaf.css'] },
  { id: 'either', fixture: 'p3a-either.html', target: '.grid .plan:nth-child(2) button', idioms: ['item.either', 'leaf.aria.shown', 'variant.click'], toggled: 'input[type=radio]', cy: ['item.either', 'leaf.css.shown', 'variant.click'] },
  { id: 'twin-toggle', fixture: 'p3a-either.html', target: '.grid .plan:nth-child(1) button:not([hidden])', idioms: ['item.either', 'leaf.aria.shown'], cy: ['item.either', 'leaf.css.shown'] },
  { id: 'twin', fixture: 'p3a-twin.html', target: '.card:nth-child(2) .primary', idioms: ['item.label', 'leaf.aria.shown'], not: ['leaf.aria', 'leaf.css'], cy: ['item.label', 'leaf.css.shown'] },
  { id: 'clash', fixture: 'p3a-heading-clash.html', target: '.card:nth-child(2) button', idioms: ['item.attribute', 'leaf.css'], not: ['leaf.aria', 'leaf.aria.shown'], cy: ['item.attribute', 'leaf.css'] },
  { id: 'group-hidden', fixture: 'p3a-groups.html', target: 'input[value="individuals"]', idioms: ['group.aria', 'group.label-click'], select: true },
  { id: 'group-tabs', fixture: 'p3a-groups.html', target: 'button[role=tab]:nth-of-type(2)', idioms: ['group.aria'] },
  { id: 'cell', fixture: 'p3a-compare.html', target: 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)', idioms: ['cell.xpath'] },
  { id: 'transformed', fixture: 'p3a-transformed.html', target: '.row:nth-child(1) button', none: /text-transform/ },
];
