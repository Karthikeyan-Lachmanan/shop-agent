import type { Customer, CustomerField } from './types';

export type CustomerErrors = Partial<Record<CustomerField, string>>;

/** Indian mobile: optional +91 / 0 prefix, then 10 digits starting 6–9. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, '').replace(/^\+?91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function validateCustomer(input: Customer, required: CustomerField[]): { customer: Customer; errors: CustomerErrors } {
  const errors: CustomerErrors = {};
  const customer: Customer = {
    name: input.name.trim(),
    phone: input.phone.trim(),
    address: input.address.trim(),
    email: input.email.trim(),
  };
  for (const f of required) if (!customer[f]) errors[f] = 'required';
  if (customer.phone) {
    const phone = normalizePhone(customer.phone);
    if (phone) customer.phone = phone;
    else errors.phone = 'must be a 10-digit Indian mobile number';
  }
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) errors.email = 'invalid email';
  if (customer.address && customer.address.length < 10) errors.address = 'too short — need door no, street, area and city';
  return { customer, errors };
}
