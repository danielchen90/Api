export class Event {
  id?: string;
  churchId?: string;
  groupId?: string;
  allDay?: boolean;
  start?: Date;
  end?: Date;
  title?: string;
  description?: string;
  visibility?: string;
  recurrenceRule?: string;
  exceptionDates?: Date[];
  registrationEnabled?: boolean;
  capacity?: number;
  registrationOpenDate?: Date;
  registrationCloseDate?: Date;
  tags?: string;
  formId?: string;
  approvalStatus?: string;
  requestedBy?: string;
  // Public website listing (2026-09 redesign). publicListing opts the event into
  // GET /content/events/public/:churchId; campusId NULL = network-wide.
  campusId?: string | null;
  publicListing?: boolean;
  location?: string | null;
  registrationUrl?: string | null;
  image?: string | null;
}
