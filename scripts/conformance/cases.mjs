// One case per idiom-table shape (spec §10): a fixture page, the element to inspect, and what the renderer is expected to say.
// `idioms` are the ones the rendered helper must use; `none` marks a page the renderer must decline.
export const CASES = [
  { id: 'attribute', fixture: 'p3a-attribute.html', target: '[data-testid="sku-beta"] button', idioms: ['item.attribute', 'leaf.aria'] },
  { id: 'label', fixture: 'p3a-label.html', target: '.faq:nth-child(2) .faq__q', idioms: ['item.label', 'leaf.css'] },
  { id: 'either', fixture: 'p3a-either.html', target: '.grid .plan:nth-child(2) button', idioms: ['item.either', 'leaf.aria.shown', 'variant.click'], toggled: 'input[type=radio]' },
  { id: 'twin-toggle', fixture: 'p3a-either.html', target: '.grid .plan:nth-child(1) button:not([hidden])', idioms: ['item.either', 'leaf.aria.shown'] },
  { id: 'twin', fixture: 'p3a-twin.html', target: '.card:nth-child(2) .primary', idioms: ['item.label', 'leaf.aria.shown'], not: ['leaf.aria', 'leaf.css'] },
  { id: 'clash', fixture: 'p3a-heading-clash.html', target: '.card:nth-child(2) button', idioms: ['item.attribute', 'leaf.css'], not: ['leaf.aria', 'leaf.aria.shown'] },
  { id: 'transformed', fixture: 'p3a-transformed.html', target: '.row:nth-child(1) button', none: /text-transform/ },
];
