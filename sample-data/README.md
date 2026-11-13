# Sample data for testing roster import

Fictional people with `@example.com` addresses. Import them into a **sandbox** institution, for example as `admin@westbridge.example`, from **Students & Alumni → Import roster**. Never import test files into a real partner's account.

| File | Import as | Expected result |
| :--- | :--- | :--- |
| `students_roster.csv` | Current students | **20 imported**, 0 duplicates, 0 errors. A student who then signs up with one of these emails is verified automatically. |
| `alumni_roster.csv` | Graduates / alumni | **20 imported**. Names with commas in quotes, such as `"Sen, Siddharth"` and `"D'Souza, Leon"`, stay in one column. Importing the file a second time gives **0 imported, 20 duplicates skipped**. |
| `roster_with_errors.csv` | Either | **4 imported, 1 duplicate skipped, 3 errors.** Row 4 has an invalid email, row 5 has no name, and row 9 has no email. The blank line is ignored. Farhan Ali has no batch year, so he imports with the current year. Use this file for the "When things go wrong" demo segment. |
| `school_roster_extra_columns.csv` | Current students | **Known limitation.** Columns are matched by keyword, and the first match wins, so "Father's Name" is taken as the student's name. All 3 rows import under the fathers' names. Delete extra columns before importing. This is logged in the sandbox feedback log as a candidate fix. |

Each import is recorded in **Data & Privacy → Audit log** as `ROSTER_IMPORTED`, with the counts.
