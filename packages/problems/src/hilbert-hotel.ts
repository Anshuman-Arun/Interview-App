import {
  DisclosureIdSchema,
  type InterviewProblem
} from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";

const singleGuestShiftDisclosure = DisclosureIdSchema.parse("disclosure_hilbert_single_guest_shift");
const infiniteBusDisclosure = DisclosureIdSchema.parse("disclosure_hilbert_infinite_bus_even_odd");

export const hilbertHotelProblem: InterviewProblem = {
  id: "oxford-hilbert-hotel",
  version: "1.0.0",
  public: {
    prompt: "Suppose the Grand Hotel has countably infinitely many rooms numbered 1, 2, 3, ..., and every room is occupied. (a) Can the hotel accommodate one newly arrived guest without evicting anyone? (b) Can it accommodate a countably infinite bus of new guests numbered 1, 2, 3, ...? Provide explicit, well-defined room assignment mappings for each case.",
    givenInformation: [
      "The set of rooms is indexed by the positive integers {1, 2, 3, ...}.",
      "Every current room n is initially occupied by exactly one guest."
    ]
  },
  interviewer: {
    topics: ["set theory", "cardinality", "bijection", "countable infinity"],
    difficulty: "introductory-oxford",
    reasoningGraph: {
      version: "1.0.0",
      approaches: [
        { id: "arithmetic-shift", label: "Arithmetic coordinate shift" },
        { id: "parity-partition", label: "Even-odd parity partition" }
      ],
      milestones: [
        {
          id: "infinite-set-concept",
          description: "Recognize that an infinite set can be placed in bijection with a proper subset of itself.",
          approachIds: ["arithmetic-shift", "parity-partition"],
          optionalPrerequisiteIds: [],
          protectedDisclosureIds: []
        },
        {
          id: "single-guest-shift",
          description: "Formulate the shift mapping f(n) = n + 1 for existing guests to vacate room 1.",
          approachIds: ["arithmetic-shift"],
          optionalPrerequisiteIds: ["infinite-set-concept"],
          protectedDisclosureIds: [singleGuestShiftDisclosure]
        },
        {
          id: "infinite-bus-mapping",
          description: "Formulate the mapping f(n) = 2n for existing guests, placing bus guest k into room 2k - 1.",
          approachIds: ["parity-partition"],
          optionalPrerequisiteIds: ["single-guest-shift"],
          protectedDisclosureIds: [infiniteBusDisclosure]
        },
        {
          id: "bijection-rigor",
          description: "Verify that both assignment mappings are injective and cover all designated guests without collisions.",
          approachIds: ["arithmetic-shift", "parity-partition"],
          optionalPrerequisiteIds: ["infinite-bus-mapping"],
          protectedDisclosureIds: []
        }
      ],
      edges: [
        { from: "infinite-set-concept", to: "single-guest-shift" },
        { from: "single-guest-shift", to: "infinite-bus-mapping" },
        { from: "infinite-bus-mapping", to: "bijection-rigor" }
      ],
      commonErrors: [
        { id: "last-room-fallacy", description: "Attempts to place someone into the non-existent 'last' room or 'room infinity'." },
        { id: "finite-pigeonhole", description: "Incorrectly concludes accommodation is impossible by assuming finite pigeonhole constraints." }
      ],
      extensions: [
        { id: "infinitely-many-buses", prompt: "How would you accommodate countably infinitely many buses, each carrying countably infinitely many guests?" }
      ]
    },
    protectedDisclosures: [
      {
        id: singleGuestShiftDisclosure,
        fact: "Move the occupant of room n to room n + 1, vacating room 1 for the new guest.",
        minimumDisclosureLevel: 2,
        equivalentFormulations: [
          "move room n to n+1",
          "shift each guest to n+1",
          "move the occupant of room n to room n+1",
          "vacate room 1",
          "f(n) = n + 1"
        ]
      },
      {
        id: infiniteBusDisclosure,
        fact: "Move occupant n to room 2n to vacate all odd-numbered rooms 2k - 1 for the infinite bus guests.",
        minimumDisclosureLevel: 4,
        equivalentFormulations: [
          "move n to 2n",
          "move occupant n to room 2n",
          "even rooms to current guests and odd rooms to new guests",
          "place bus guest k into room 2k-1",
          "f(n) = 2n"
        ]
      }
    ]
  },
  private: {
    canonicalSolution: "(a) Move guest in room n to room n+1 for all n >= 1; place new guest in room 1. (b) Move guest in room n to room 2n for all n >= 1; place guest k from the bus into room 2k-1 for all k >= 1. Both mappings are bijections between countable sets.",
    verificationNotes: "Ensure student proves both injectivity (no two people assigned to the same room) and surjectivity onto the assigned room targets."
  }
};

assertInterviewProblemIntegrity(hilbertHotelProblem);
