// A component test: Testing Library queries a rendered component, not the app page — cor_check leaves it alone.
import { render, screen } from '@testing-library/react';
test('badge', () => { render(<Badge n={2} />); expect(screen.getByRole('status')).toHaveTextContent('2'); });
