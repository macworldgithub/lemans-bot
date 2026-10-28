const { LEMANS_SYSTEM_PROMPT, SAVE_LEAD_TOOL } = require('../dist/voice/lemans-knowledge');

console.log("=================================================");
console.log("LEMANS BOT - COMPLETE CSV COMPLIANCE AUDIT");
console.log("=================================================\n");

const tests = [
  {
    name: "Business Profile - Venue Name & Inbound Numbers",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("LeMans Entertainment") &&
             p.includes("(03) 8787 8741") &&
             p.includes("(03) 8797 1458") &&
             p.includes("55 Waterview Close") &&
             p.includes("57 Waterview Close") &&
             p.includes("customerservice@lemansgokarts.com.au") &&
             p.includes("info@lemansgokarts.com.au");
    }
  },
  {
    name: "Operating Hours - Exact CSV Schedule",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("9:45 in the morning until 5:30 in the afternoon") &&
             p.includes("9:45 in the morning until 10:00 at night") &&
             p.includes("10:15 in the morning until 9:00 at night") &&
             p.includes("9:15 in the morning until 11:00 at night") &&
             p.includes("9:15 in the morning until 10:00 at night") &&
             p.includes("9:00 in the morning until close");
    }
  },
  {
    name: "Activities & Ages - 4 Tracks & 5 Karts",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("Lakeside Track (650m)") &&
             p.includes("Penrite Track (620m)") &&
             p.includes("Racer Industries Circuit (200m") &&
             p.includes("Mushroom Raceway") &&
             p.includes("Super Karts") &&
             p.includes("Sprint Karts") &&
             p.includes("Rookie Karts") &&
             p.includes("Mini Karts") &&
             p.includes("Twin Karts");
    }
  },
  {
    name: "Activities & Ages - Laserzone, VR, Golf, Arcade, Paintball",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("Laserzone") &&
             p.includes("Zero Latency Virtual Reality") &&
             p.includes("Indoor Mini Golf") &&
             p.includes("Arcadia") &&
             p.includes("Paintball") &&
             p.includes("Engineerium") &&
             p.includes("Far Cry VR");
    }
  },
  {
    name: "Safety & Medical - Absolute Exclusions & No Medical Clearance",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("pregnant or who have epilepsy") &&
             p.includes("NEVER MEDICALLY CLEAR ANYONE") &&
             p.includes("Enclosed shoes are mandatory") &&
             p.includes("Online Safety Waiver");
    }
  },
  {
    name: "Food, Catering & Strict BYO Policy",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("STRICT OUTSIDE FOOD & BYO POLICY") &&
             p.includes("Birthday Cakes") &&
             p.includes("Lolly Bags") &&
             p.includes("No cakeage fee") &&
             p.includes("Sports Bar");
    }
  },
  {
    name: "Packages & Prices - Rates & Inclusions",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("thirty-nine dollars off-peak and forty-nine dollars peak") &&
             p.includes("Hang Out") &&
             p.includes("Show Off") &&
             p.includes("Speed Demon") &&
             p.includes("Monza") &&
             p.includes("LeMans Race Package") &&
             p.includes("NEVER quote corporate rates");
    }
  },
  {
    name: "Booking & Payments - Deposit, Reschedule & Numbers Drop",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("equal to 10 guests for Go-Kart") &&
             p.includes("equal to 8 guests for VR") &&
             p.includes("strictly NON-REFUNDABLE") &&
             p.includes("at least 7 days' advance notice") &&
             p.includes("at least 24 hours' notice") &&
             p.includes("high estimate");
    }
  },
  {
    name: "Transfer Rules - Priority Escalations & Pathways",
    check: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return p.includes("Skye") &&
             p.includes("Triple Zero (000)") &&
             p.includes("PATHWAY H: AFTER-HOURS CALLS") &&
             p.includes("PATHWAY I: SCHOOL GROUPS & EXCURSIONS") &&
             p.includes("PATHWAY J: EMPLOYMENT, MEDIA & SUPPLIER INQUIRIES") &&
             p.includes("PATHWAY G: COMPLAINTS & REFUND REQUESTS");
    }
  },
  {
    name: "SAVE_LEAD_TOOL - Schema, Email & Event Types",
    check: () => {
      const props = SAVE_LEAD_TOOL.parameters.properties;
      const enumVals = props.event_type.enum;
      const expectedEnums = [
        'kids_party', 'teen_party', 'buck_party', 'corporate',
        'adult_party', 'karts', 'vr', 'activities',
        'booking_change', 'complaint', 'after_hours',
        'school_group', 'general_enquiry', 'unknown'
      ];
      const hasEmail = Boolean(props.caller_email);
      const allEnumsPresent = expectedEnums.every(e => enumVals.includes(e));
      return hasEmail && allEnumsPresent;
    }
  }
];

let allPassed = true;
tests.forEach((t, i) => {
  const passed = t.check();
  console.log(`[${passed ? 'PASS' : 'FAIL'}] Test ${i + 1}: ${t.name}`);
  if (!passed) allPassed = false;
});

console.log("\n-------------------------------------------------");
console.log(`Result: ${allPassed ? "ALL 10 VERIFICATION CHECKS PASSED!" : "SOME CHECKS FAILED"}`);
console.log("-------------------------------------------------");

process.exit(allPassed ? 0 : 1);
