use crate::Governance;
use dep::aztec::test::helpers::test_environment::TestEnvironment;

// ============================================================================
// INITIALIZATION TESTS
// ============================================================================

// Test: Contract initialization
#[test]
unconstrained fn test_initializer() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();

    let initializer_call_interface = Governance::interface().constructor(admin);
    let contract_addr =
        env.deploy("Governance").with_private_initializer(admin, initializer_call_interface);

    let current = env.simulate_utility(Governance::at(contract_addr)._view_current_id());

    assert(current == 0)
}
