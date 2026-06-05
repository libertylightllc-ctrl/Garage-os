# GarageOS — Job Card Data Model

The complete job-card field list, derived from the real workshop job card. Every field is tagged with the ROLE that fills it and the STAGE it's filled at. This is the source of truth for the job-card schema and forms — build every field so the "missing fields / blank Vehicle" bug can't recur.

Roles: Advisor · Technician · Cashier · Customer · System
Stages: Reception → Diagnosis → Estimate → Approval#1 → Repair → (Re-estimate → Approval#2) → QC → Billing → Delivery → Reminders

---

## Header
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Job Card No (e.g. JC-2026-0001) | string (auto) | System | Reception | yes |
| Date | date | System | Reception | yes |
| Time In | time | System/Advisor | Reception | yes |
| Service Advisor (name) | ref to user | Advisor | Reception | yes |
| Branch | ref to branch | System | Reception | yes |

## Customer Information
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Customer Name | string | Advisor (Moulkia OCR) | Reception | yes |
| Mobile Number | string | Advisor (manual) | Reception | yes |
| Email | string | Advisor (manual) | Reception | no |

> Repeat customer: plate lookup auto-fills name from record. Vehicle sold: advisor can edit name + mobile.

## Vehicle Information
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Plate Number | string | Advisor (OCR/lookup) | Reception | yes |
| VIN | string | Advisor (OCR) | Reception | yes |
| Make | string | Advisor (OCR) | Reception | yes |
| Model | string | Advisor (OCR) | Reception | yes |
| Year | int | Advisor (OCR) | Reception | yes |
| Odometer / Mileage In | int | Advisor (manual) | Reception | yes |
| Fuel Level | enum: Empty/¼/½/¾/Full | Advisor | Reception | yes |
| Oil Type (for reminders) | enum: 5000km / 10000km / none | Advisor | Reception | when oil service |

> Make/Model/Year missing = the "blank Vehicle" bug. These must persist on create.

## Customer Complaint
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Complaint | text (or voice→text) | Advisor (from customer) | Reception | yes |

## Vehicle Condition at Reception (dispute shield)
| Field | Type | Role | Stage |
|---|---|---|---|
| Exterior: No Damage / Scratches / Dents / Broken Light / Cracked Windshield | multi-checkbox | Advisor | Reception |
| Exterior Remarks | text | Advisor | Reception |
| Interior: Clean / Dirty / Warning Light ON / Other | multi-checkbox | Advisor | Reception |
| Interior Remarks | text | Advisor | Reception |
| Check-in Photo(s) | photo[] | Advisor | Reception |

## Customer Valuables Left in Vehicle
| Field | Type | Role | Stage |
|---|---|---|---|
| None / Documents / Cash / Mobile Charger / Other(+text) | multi-checkbox + text | Advisor | Reception |

## AI Work Order for Technician (generated checklist)
System-generated task list for the technician: verify complaint · visual inspection · diagnostic scan if needed · identify root cause · photograph damaged parts · prepare recommendation · submit estimate to advisor · await approval · carry out approved repairs · QC · road test if needed · confirm complaint resolved.
| Field | Type | Role | Stage |
|---|---|---|---|
| Work order checklist (items + checked state) | checklist | System generates / Technician checks off | Diagnosis→Repair |

## Technician Findings
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Findings / Diagnosis | text (+voice/photo) | Technician | Diagnosis | yes |

## Parts Required (quoted)
| Field | Type | Role | Stage |
|---|---|---|---|
| Lines: Part No · Description · Qty | table | Technician | Diagnosis |

> "Required" (quoted) is SEPARATE from "Used" (actual). Keep two lists.

## Repair Estimate (first quote)
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Parts Cost | money | Cashier | Estimate | yes |
| Labor Cost | money | Cashier | Estimate | yes |
| VAT/Tax (5%) | money (AUTO) | System | Estimate | yes |
| Total Estimate | money (AUTO) | System | Estimate | yes |

> Cashier sets prices, NOT advisor/technician. VAT auto-calculated, shown as separate line.

## Customer Approval #1
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Approved / Not Approved | enum | Customer | Approval#1 | yes |
| Approval record (WhatsApp msg = signature equivalent) | timestamp + ref | System | Approval#1 | yes |
| Approved Amount | money | System | Approval#1 | yes |

> No work starts before Approval#1. If extra problems found mid-repair → Re-estimate → Approval#2 (work auto-pauses until approved).

## Work Completed
| Field | Type | Role | Stage |
|---|---|---|---|
| Work completed notes | text | Technician | Repair |

## Parts Used (actual)
| Field | Type | Role | Stage |
|---|---|---|---|
| Lines: Part No · Description · Qty | table | Technician | Repair |

> May differ from Parts Required — this is why Final Billing can differ from Estimate.

## Quality Control
| Field | Type | Role | Stage |
|---|---|---|---|
| Repair Completed / Road Test Completed / No Warning Lights / Vehicle Cleaned | multi-checkbox | Technician/QC | QC |
| QC Inspector | ref to user | QC | QC |
| QC Signature/sign-off | signature/confirm | QC | QC |

## Final Billing
| Field | Type | Role | Stage | Required |
|---|---|---|---|---|
| Parts | money | Cashier | Billing | yes |
| Labor | money | Cashier | Billing | yes |
| VAT/Tax (5%) | money (AUTO) | System | Billing | yes |
| Total Amount | money (AUTO) | System | Billing | yes |
| Payment method (Cash / Card-POS) | enum | Cashier | Billing | yes |

> Recorded, NOT processed — garage uses own cash/POS. Cashier has full invoice edit power.

## Vehicle Delivery
| Field | Type | Role | Stage |
|---|---|---|---|
| Mileage Out | int | Advisor/Cashier | Delivery |
| Delivered By | ref to user | System | Delivery |
| Delivery Date | date | System | Delivery |
| Delivery Time | time | System | Delivery |
| Customer collection record (signature / confirm) | signature/confirm | Customer | Delivery |

## Job Status (lifecycle)
enum: Open · Waiting for Approval · In Progress · Waiting for Parts · Completed · Delivered
> Maps to existing JobStatus + HoldReason (AWAITING_APPROVAL / AWAITING_PART / AWAITING_CUSTOMER).

## Consent (compliance)
| Field | Type | Role | Stage |
|---|---|---|---|
| Moulkia consent recorded | timestamp | System (captured at onboarding/intake) | Reception |

---

## Notes for the build
1. **Two parts lists** (Required vs Used) and **two cost blocks** (Estimate vs Final Billing) are intentional — never merge them.
2. **One record, many roles:** this is ONE JobCard the four roles add to as it moves through stages — not one person filling a form top to bottom.
3. **VAT is automatic** everywhere; cashier never types it.
4. **Make/Model/Year/Mileage/Complaint/OilType must persist on create** — their absence is the current bug.
5. Reuse existing schema where it already fits (Estimate/Invoice, JobStatus/HoldReason, Vehicle, approval timestamps). Add: mileageIn/mileageOut, complaint, oilType, fuel level, condition checkboxes, valuables, findings, QC fields, delivery fields, moulkiaConsentAt.
