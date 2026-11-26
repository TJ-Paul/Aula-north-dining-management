// Parses the hall office's coupon register (CSV) into rows for import_coupons.
// Accepts a header row (coupon / name / student id, any order; room and phone
// too if the hall adds them) or, without one, coupon, name, student id in that order.

export type RegistryRow = { coupon_number: number; hall_record: { name?: string; student_id?: string; room?: string; phone?: string } };

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const HEADERS: Record<string, keyof RegistryRow['hall_record'] | 'coupon'> = {
  coupon: 'coupon', coupon_number: 'coupon', 'coupon no': 'coupon', 'coupon number': 'coupon',
  name: 'name', 'student name': 'name', 'full name': 'name',
  'student id': 'student_id', student_id: 'student_id', 'student id no': 'student_id', 'id no': 'student_id', id: 'student_id',
  'reg no': 'student_id', 'registration no': 'student_id', 'roll': 'student_id', 'roll no': 'student_id',
  room: 'room', 'room no': 'room',
  phone: 'phone', mobile: 'phone', 'phone number': 'phone', 'mobile number': 'phone',
};

export function parseRegistryCsv(text: string): { rows: RegistryRow[]; errors: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l, i) => ({ n: i + 1, cells: splitLine(l) }))
    .filter((l) => l.cells.some((c) => c !== ''));
  const errors: string[] = [];
  if (lines.length === 0) return { rows: [], errors: ['The file is empty.'] };

  let columns: Array<keyof RegistryRow['hall_record'] | 'coupon' | null> = ['coupon', 'name', 'student_id'];
  if (!/^\d+$/.test(lines[0].cells[0])) {
    columns = lines[0].cells.map((h) => HEADERS[h.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim()] ?? HEADERS[h.toLowerCase()] ?? null);
    if (!columns.includes('coupon')) return { rows: [], errors: ['The header row needs a "coupon" column.'] };
    lines.shift();
  }

  const seen = new Map<number, number>();
  const rows: RegistryRow[] = [];
  for (const { n, cells } of lines) {
    const row: RegistryRow = { coupon_number: NaN, hall_record: {} };
    columns.forEach((col, i) => {
      const v = cells[i] ?? '';
      if (col === 'coupon') row.coupon_number = /^\d{1,6}$/.test(v) ? Number(v) : NaN;
      else if (col && v) row.hall_record[col] = v;
    });
    if (row.hall_record.student_id) row.hall_record.student_id = row.hall_record.student_id.replace(/[\s/-]/g, '').toUpperCase();
    if (!Number.isInteger(row.coupon_number) || row.coupon_number < 1) {
      errors.push(`Line ${n}: "${cells[columns.indexOf('coupon')] ?? ''}" is not a coupon number.`);
      continue;
    }
    if (seen.has(row.coupon_number)) {
      errors.push(`Line ${n}: coupon ${row.coupon_number} already appears on line ${seen.get(row.coupon_number)}.`);
      continue;
    }
    if (!row.hall_record.student_id) errors.push(`Line ${n}: coupon ${row.coupon_number} has no student ID.`);
    seen.set(row.coupon_number, n);
    rows.push(row);
  }
  return { rows, errors };
}
