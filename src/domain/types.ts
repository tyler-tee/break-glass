export type LocationStatus = 'candidate' | 'approved' | 'warn' | 'rejected';
export type BusinessStatus = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
export type ProtocolStatus = 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';
export type Interval = { open: string; close: string };          // "HHMM"; close < open means next day
export type WeeklyHours = { periods: Record<'0'|'1'|'2'|'3'|'4'|'5'|'6', Interval[]>; weekdayText: string[] }; // '0' = Sunday
export type TrackedFields = {
  name: string | null; address: string | null; phone: string | null; website: string | null;
  hours: WeeklyHours | null; businessStatus: BusinessStatus | null;
  rating: number | null; ratingCount: number | null;
  afterHoursNotes: string | null; walkIns: boolean | null; insuranceNotes: string | null;
};
export type FieldChange = { field: keyof TrackedFields | 'verification'; oldValue: string | null; newValue: string | null };
export type LatLng = { lat: number; lng: number };
export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;
