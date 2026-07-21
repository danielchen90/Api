import type {
  AccessLog, Answer, ApiKey, AssociatedGroup, AuditLog, Auxiliary, Campus, CampusContent, Church, ClientError, Domain, Form,
  FormSubmission, Group, GroupJoinRequest, GroupMember, GroupMemberHistory, Household, List, ListMember, MemberPermission,
  OAuthClient, OAuthCode, OAuthDeviceCode, OAuthRelaySession, OAuthToken,
  OrdinationType, PersonOrdination, PersonPhotoCrop, LicenseTemplate, LicenseTemplateVersion, LicenseCard, PrintBatch,
  Question, Role, RoleMember, RolePermission, Setting, User, UserCampus, UserChurch,
  UserAuxiliary, VisibilityPreference, Webhook, WebhookDelivery
} from "../models/index.js";

/**
 * The people table stores flattened name/contact columns rather than
 * the composite Name/ContactInfo objects used in the Person model.
 * rowToModel() in PersonRepo maps these back to the Person model shape.
 */
export interface PeopleTable {
  id?: string;
  churchId?: string;
  displayName?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  nickName?: string;
  prefix?: string;
  suffix?: string;
  birthDate?: Date;
  dateAdded?: Date;
  gender?: string;
  maritalStatus?: string;
  anniversary?: Date;
  membershipStatus?: string;
  homePhone?: string;
  mobilePhone?: string;
  workPhone?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  photoUpdated?: Date;
  householdId?: string;
  householdRole?: string;
  campusId?: string;
  conversationId?: string;
  optedOut?: boolean;
  nametagNotes?: string;
  donorNumber?: string;
  importKey?: string;
  removed?: boolean;
}

/**
 * campusSlugAlias — maps an OLD campus slug -> the CURRENT campus id so a rename
 * keeps the previous public URL alive as a 301 alias (SITE-03, SC#2). There is no
 * model class for this lookup table; the row shape is declared inline here.
 */
export interface CampusSlugAliasTable {
  id?: string;
  churchId?: string;
  slug?: string;
  campusId?: string;
  createdAt?: Date;
}

export interface MembershipDatabase {
  accessLogs: AccessLog;
  answers: Answer;
  apiKeys: ApiKey;
  associatedGroups: AssociatedGroup;
  auditLogs: AuditLog;
  auxiliaries: Auxiliary;
  campuses: Campus;
  // Per-campus public-website content (CMS-01). One row per (churchId, campusId,
  // contentType); campusId NULL = the org default, non-null = a SPARSE campus
  // override. `content` is longtext JSON; `version` is the OCC guard. The
  // DB-generated read-only `campusKey` column (COALESCE(campusId,'~ORG~'), backing
  // the NULL-safe org-default unique index) is omitted from the CampusContent
  // model and cast away on selectAll() if needed.
  campusContent: CampusContent;
  campusSlugAlias: CampusSlugAliasTable;
  churches: Omit<Church, "settings">;
  clientErrors: ClientError;
  domains: Domain;
  forms: Omit<Form, "action" | "questions"> & { removed?: boolean; archived?: boolean };
  formSubmissions: Omit<FormSubmission, "form" | "questions" | "answers">;
  groups: Omit<Group, "labelArray" | "memberCount" | "importKey"> & { removed?: boolean };
  groupMembers: Omit<GroupMember, "person" | "group">;
  groupMemberHistory: GroupMemberHistory;
  groupJoinRequests: Omit<GroupJoinRequest, "person" | "group">;
  households: Household;
  lists: Omit<List, "conditions" | "createdByPersonName" | "rules" | "actions" | "autoRefresh" | "notifyOnChange"> & {
    conditions: string;
    rules?: string;
    actions?: string;
    autoRefresh?: number;
    notifyOnChange?: number;
    dateCreated?: Date;
    dateModified?: Date;
  };
  listMembers: ListMember;
  memberPermissions: Omit<MemberPermission, "personName" | "formName">;
  oAuthClients: OAuthClient;
  oAuthCodes: OAuthCode;
  oAuthDeviceCodes: OAuthDeviceCode;
  oAuthRelaySessions: OAuthRelaySession;
  oAuthTokens: OAuthToken;
  ordinationTypes: OrdinationType;
  // DB-generated read-only `activeFlag` column is omitted from PersonOrdination
  // (the model never writes it); repos cast it away on selectAll() if needed.
  personOrdinations: PersonOrdination;
  // PHO-04 normalized license-crop transform (one per person+purpose). Crop
  // fields are decimal(7,5) in MySQL; the repo coerces them to numbers on read.
  personPhotoCrops: PersonPhotoCrop;
  // License card templates (TPL-03, TPL-04). The DB-generated read-only
  // defaultFlag/activeFlag columns are omitted from the LicenseTemplate model
  // (the app never writes them) and cast away on selectAll() if needed; isDefault/
  // active/removed are bit(1) coerced to booleans by the repo.
  licenseTemplates: LicenseTemplate;
  // Immutable per-save snapshots (TPL-03 audit history), keyed
  // UNIQUE(churchId, templateId, versionNumber).
  licenseTemplateVersions: LicenseTemplateVersion;
  // PRT-03 print-audit rows (one per confirmed CR80 print): campus-scoped,
  // append-only, capturing actor/timestamp/templateVersion/pdfRef/person/
  // ordination/campus. `templateVersion` is int and `removed` is bit(1);
  // the repo coerces them (number/boolean) on read. Phase-7 adds batchId +
  // the status lifecycle columns (batchId/status/printedAt/void*) via ALTER.
  licenseCards: LicenseCard;
  // PRT-02 batch-render entity (one per launched batch): provenance (filterJson),
  // DB-backed progress (status + cardCount/renderedCount), per-person skips
  // (skippedJson) and the assembled-PDF FileStorage key (pdfRef). cardCount/
  // renderedCount are int and `removed` is bit(1); the repo coerces them on read.
  printBatches: PrintBatch;
  people: PeopleTable;
  questions: Question & { removed?: boolean };
  roles: Role;
  roleMembers: Omit<RoleMember, "user">;
  rolePermissions: RolePermission;
  settings: Setting;
  users: Omit<User, "jwt"> & { password?: string };
  userCampuses: UserCampus;
  userAuxiliaries: UserAuxiliary;
  userChurches: UserChurch;
  visibilityPreferences: VisibilityPreference;
  webhooks: Omit<Webhook, "events" | "active"> & { events: string; active: number };
  webhookDeliveries: WebhookDelivery;
}
