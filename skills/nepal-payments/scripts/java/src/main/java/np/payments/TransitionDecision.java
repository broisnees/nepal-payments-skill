package np.payments;

/**
 * Outcome of {@link StateMachine#decideTransition}.
 *
 * @param next           status to write, or null to write nothing
 * @param reviewRequired stop automation and alert a human (amount mismatch / provider gave no amount for a "paid")
 * @param latePaid       provider says paid after we had closed the attempt: recover + alert
 * @param reason         human-readable reason for logs
 */
public record TransitionDecision(AttemptStatus next, boolean reviewRequired, boolean latePaid, String reason) {}
