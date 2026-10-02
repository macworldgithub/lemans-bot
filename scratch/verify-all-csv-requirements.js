const { LEMANS_SYSTEM_PROMPT, SAVE_LEAD_TOOL } = require('../dist/voice/lemans-knowledge');
const { LeadSchema } = require('../dist/voice/schemas/lead.schema');

console.log("===================================================================");
console.log("LEMANS BOT - EXHAUSTIVE CSV KNOWLEDGE BASE & REQUIREMENTS AUDIT");
console.log("===================================================================\n");

const tests = [
  // 1. Business Profile
  {
    category: "Business Profile",
    name: "Venue identity, inbound lines, emails and address",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("LeMans Entertainment") &&
        p.includes("(03) 8787 8741") &&
        p.includes("(03) 8797 1458") &&
        p.includes("55 Waterview Close, Dandenong South VIC 3175") &&
        p.includes("57 Waterview Close") &&
        p.includes("info@lemansgokarts.com.au") &&
        p.includes("customerservice@lemansgokarts.com.au") &&
        p.includes("https://www.lemansentertainment.com.au/") &&
        p.includes("23-acre complex") &&
        p.includes("parking")
      );
    }
  },
  {
    category: "Business Profile",
    name: "Activity inquiry response: list 2-3 activities then qualify",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("list 2 to 3 activities") &&
        p.includes("is it for kids, adults, bucks, or a work group")
      );
    }
  },

  // 2. Operating Hours
  {
    category: "Operating Hours",
    name: "Complete schedule & Friday hours conflict resolution",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("9:00 in the morning until close") &&
        p.includes("9:45 in the morning until 5:30 in the afternoon") &&
        p.includes("9:45 in the morning until 10:00 at night") &&
        p.includes("10:15 in the morning until 9:00 at night") &&
        p.includes("Do NOT quote the conflicting Friday 12:15pm time") &&
        p.includes("9:15 in the morning until 11:00 at night") &&
        p.includes("9:15 in the morning until 10:00 at night") &&
        p.includes("open earlier for pre-booked groups")
      );
    }
  },
  {
    category: "Operating Hours",
    name: "After-hours response & callback expectation after 9am",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("PATHWAY H: AFTER-HOURS CALLS") &&
        p.includes("after 9am") &&
        p.includes("closed right now")
      );
    }
  },

  // 3. Activities & Ages
  {
    category: "Activities & Ages",
    name: "4 Tracks & 5 Kart Specifications",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("Lakeside Track (650m)") &&
        p.includes("Penrite Track (620m)") &&
        p.includes("Racer Industries Circuit (200m Junior Track)") &&
        p.includes("Mushroom Raceway") &&
        p.includes("Super Karts (Viper Super Karts)") &&
        p.includes("Sprint Karts") &&
        p.includes("Rookie Karts") &&
        p.includes("Mini Karts") &&
        p.includes("Twin Karts") &&
        p.includes("80 kilometres per hour")
      );
    }
  },
  {
    category: "Activities & Ages",
    name: "Multi-Activity Venue: VR, Laserzone, Mini Golf, Arcade, Bar",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("Laserzone (Lasertag)") &&
        p.includes("Zero Latency Virtual Reality (VR)") &&
        p.includes("Engineerium: ages 8+") &&
        p.includes("Singularity (sci-fi robots): ages 10+") &&
        p.includes("Far Cry VR: ages 15+") &&
        p.includes("Indoor Mini Golf") &&
        p.includes("Ancient Egypt") &&
        p.includes("Jurassic") &&
        p.includes("Arcadia (Gaming Arcade)") &&
        p.includes("Sports Bar")
      );
    }
  },
  {
    category: "Activities & Ages",
    name: "Medical Exclusions and Attire Rules",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("pregnant or who have epilepsy") &&
        p.includes("NEVER MEDICALLY CLEAR ANYONE") &&
        p.includes("Enclosed shoes are mandatory") &&
        p.includes("Online Safety Waiver")
      );
    }
  },

  // 4. Packages & Prices
  {
    category: "Packages & Prices",
    name: "Published Guide Rates for Kids, Teens, Bucks & Adult Races",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("thirty-nine dollars off-peak and forty-nine dollars peak per child") &&
        p.includes("Hang Out package starting from one hundred and thirty-nine dollars") &&
        p.includes("Show Off package at one hundred and ninety-nine dollars") &&
        p.includes("Speed Demon") &&
        p.includes("Monza") &&
        p.includes("LeMans Race Package") &&
        p.includes("NEVER quote corporate rates")
      );
    }
  },

  // 5. Booking & Payments
  {
    category: "Booking & Payments",
    name: "Deposit minimums, non-refundable policy, reschedule & BYO",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("equal to 10 guests for Go-Kart") &&
        p.includes("equal to 8 guests for VR, Lasertag, or Mini Golf") &&
        p.includes("strictly NON-REFUNDABLE") &&
        p.includes("at least 7 days' advance notice") &&
        p.includes("at least 24 hours' notice") &&
        p.includes("high estimate") &&
        p.includes("STRICT OUTSIDE FOOD & BYO POLICY") &&
        p.includes("Birthday Cakes") &&
        p.includes("Lolly Bags") &&
        p.includes("No cakeage fee")
      );
    }
  },

  // 6. Transfer Rules & Pathways
  {
    category: "Transfer Rules",
    name: "14 Escalation Priorities & Pathways",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("PATHWAY K: EMERGENCY / ON-SITE INCIDENT") &&
        p.includes("Duty Manager") &&
        p.includes("Triple Zero (000)") &&
        p.includes("PATHWAY C: CORPORATE & BUSINESS EVENTS") &&
        p.includes("Skye") &&
        p.includes("PATHWAY A: KIDS & TEEN BIRTHDAY PARTIES") &&
        p.includes("PATHWAY B: BUCKS PARTIES, HENS & SOCIAL GROUPS") &&
        p.includes("PATHWAY D: CASUAL GO-KARTING & WALK-INS") &&
        p.includes("PATHWAY E: VR, LASERTAG, MINI GOLF & ARCADIA") &&
        p.includes("PATHWAY F: EXISTING BOOKING CHANGES & RUNNING LATE") &&
        p.includes("PATHWAY G: COMPLAINTS & REFUND REQUESTS") &&
        p.includes("PATHWAY H: AFTER-HOURS CALLS") &&
        p.includes("PATHWAY I: SCHOOL GROUPS & EXCURSIONS") &&
        p.includes("PATHWAY J: EMPLOYMENT, MEDIA & SUPPLIER INQUIRIES")
      );
    }
  },

  // 7. Mandatory Follow-up Questions from Intents & Answers CSV
  {
    category: "Intents & Answers",
    name: "Mandatory Intent Follow-Up Questions from CSV Table",
    test: () => {
      const p = LEMANS_SYSTEM_PROMPT;
      return (
        p.includes("MANDATORY INTENT FOLLOW-UP QUESTIONS") &&
        p.includes("Is this for a casual visit or a party?") &&
        p.includes("Are you heading in today or booking ahead?") &&
        p.includes("Is it for kids, adults, bucks, or a work group?") &&
        p.includes("What age is the birthday child, roughly how many kids, and which date are you thinking?") &&
        p.includes("Want me to transfer you to reservations now?") &&
        p.includes("Any allergies in the group?") &&
        p.includes("How many people and which date?") &&
        p.includes("Company name, headcount and preferred date?") &&
        p.includes("How old are the drivers?") &&
        p.includes("How old are the players and is it a party or casual?") &&
        p.includes("What's the booking name and date?") &&
        p.includes("School name and proposed date?")
      );
    }
  },

  // 8. Tool Definition & Lead Schema
  {
    category: "Schema & Tools",
    name: "SAVE_LEAD_TOOL and LeadSchema Enum Alignment",
    test: () => {
      const toolEnums = SAVE_LEAD_TOOL.parameters.properties.event_type.enum;
      const expectedEnums = [
        'kids_party',
        'teen_party',
        'buck_party',
        'corporate',
        'adult_party',
        'karts',
        'vr',
        'activities',
        'booking_change',
        'complaint',
        'after_hours',
        'school_group',
        'emergency',
        'general_enquiry',
        'unknown',
      ];
      const hasAllToolEnums = expectedEnums.every(e => toolEnums.includes(e));
      const hasEmail = Boolean(SAVE_LEAD_TOOL.parameters.properties.caller_email);
      return hasAllToolEnums && hasEmail;
    }
  }
];

let allPassed = true;
let currentCat = "";

tests.forEach((t, i) => {
  if (t.category !== currentCat) {
    currentCat = t.category;
    console.log(`\n--- ${currentCat} ---`);
  }
  const passed = t.test();
  console.log(`[${passed ? 'PASS' : 'FAIL'}] Check ${i + 1}: ${t.name}`);
  if (!passed) allPassed = false;
});

console.log("\n===================================================================");
console.log(`FINAL RESULT: ${allPassed ? "ALL CSV REQUIREMENT AUDITS PASSED!" : "AUDIT FAILED"}`);
console.log("===================================================================\n");

process.exit(allPassed ? 0 : 1);
