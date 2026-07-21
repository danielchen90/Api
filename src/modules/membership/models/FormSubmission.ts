import { Form, Answer, Question } from "./index.js";

export class FormSubmission {
  public id?: string;
  public churchId?: string;
  public formId?: string;
  public contentType?: string;
  public contentId?: string;
  public submissionDate?: Date;
  public submittedBy?: string;
  public revisionDate?: Date;
  public revisedBy?: string;

  // Login-free public prayer/contact submit (FRM-01..04). campusId is a DATA TAG
  // (never trusted for authorization); submissionType is "prayer" | "contact"; the
  // remaining fields hold the visitor-provided content read by the scoped inbox.
  public campusId?: string;
  public submissionType?: string;
  public unread?: boolean;
  public submitterName?: string;
  public submitterEmail?: string;
  public submitterPhone?: string;
  public message?: string;

  public form?: Form;
  public questions?: Question[];
  public answers?: Answer[];
}
