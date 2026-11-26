import { describe, expect, test } from 'vitest';
import { parseRegistryCsv } from '../../lib/csv';

describe('parseRegistryCsv', () => {
  test('reads a header row in any order and any common spelling (the hall gives name, student ID, coupon)', () => {
    const { rows, errors } = parseRegistryCsv('Student Name,Student ID,Coupon No\nRahim Uddin,2021-331 045,245\n');
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ coupon_number: 245, hall_record: { name: 'Rahim Uddin', student_id: '2021331045' } }]);
  });

  test('without a header assumes coupon, name, student ID', () => {
    expect(parseRegistryCsv('245,Rahim,2021331045').rows[0])
      .toEqual({ coupon_number: 245, hall_record: { name: 'Rahim', student_id: '2021331045' } });
  });

  test('handles quoted names with commas, blank lines, CRLF and a BOM', () => {
    const { rows } = parseRegistryCsv('﻿coupon,name,student id\r\n\r\n246,"Khan, Karim ""KK""",s-1/2\r\n');
    expect(rows).toEqual([{ coupon_number: 246, hall_record: { name: 'Khan, Karim "KK"', student_id: 'S12' } }]);
  });

  test('keeps optional room and phone columns when the hall adds them', () => {
    expect(parseRegistryCsv('coupon,name,student id,room,phone\n247,Nadia,111,,').rows[0])
      .toEqual({ coupon_number: 247, hall_record: { name: 'Nadia', student_id: '111' } });
  });

  test('reports bad and duplicate coupon numbers and missing student IDs by line', () => {
    const { rows, errors } = parseRegistryCsv('coupon,name,student id\n245,A,111\nabc,B,222\n245,C,333\n246,D,\n');
    expect(rows.map((r) => r.coupon_number)).toEqual([245, 246]);
    expect(errors).toEqual([
      'Line 3: "abc" is not a coupon number.', 'Line 4: coupon 245 already appears on line 2.', 'Line 5: coupon 246 has no student ID.',
    ]);
  });

  test('needs a coupon column', () => {
    expect(parseRegistryCsv('name,student id\nA,1').errors).toEqual(['The header row needs a "coupon" column.']);
  });
});
