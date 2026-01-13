use dep::aztec::macros::aztec;
pub mod types;
mod test;

#[aztec]
contract Governance {
    use crate::types::field_note::FieldNote;
    use crate::types::members_note::MembersNote;
    use crate::types::proposal_note::ProposalNote;
    use aztec::context;
    use aztec::keys::getters::get_public_keys;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        note::{
            note_getter_options::NoteGetterOptions, note_interface::NoteProperties,
            note_viewer_options::NoteViewerOptions,
        },
        protocol_types::{address::AztecAddress, hash::poseidon2_hash, traits::Hash},
        state_vars::{private_mutable::PrivateMutable, private_set::PrivateSet},
        utils::comparison::Comparator,
    };
    use aztec::messages::message_delivery::MessageDelivery;

    #[storage]
    struct Storage<Context> {
        members: PrivateMutable<MembersNote, Context>,
        last_proposal_id: PrivateMutable<FieldNote, Context>,
        proposals: PrivateSet<ProposalNote, Context>,
    }

    #[external("private")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        //assert(!admin.is_zero(), "invalid admin");
        let mut members = [0; 10];
        members[0] = admin.inner;
        let members_note = MembersNote::new(context.this_address(), members);
        let count_note = FieldNote::new(0, context.this_address());

        storage.last_proposal_id.initialize(count_note).emit(
            context.this_address(),
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );

        storage.members.initialize(members_note).emit(
            context.this_address(),
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    #[external("private")]
    fn create_proposal() {
        storage
            .members
            .replace(|note| {
                let msg_sender = context.msg_sender().unwrap();
                let mut is_member = false;

                // Check membership
                for i in 0..10 {
                    if note.members[i] == msg_sender.inner {
                        is_member = true;
                    }
                }
                assert(is_member, "Not a member");
                note
            })
            .emit(context.this_address(), MessageDelivery.CONSTRAINED_ONCHAIN);

        storage
            .last_proposal_id
            .replace(|note| {
                let count = note.value();
                let proposal = ProposalNote::new(context.this_address(), count);
                storage.proposals.insert(proposal).emit(
                    context.this_address(),
                    MessageDelivery.CONSTRAINED_ONCHAIN,
                );
                let new_count_note = FieldNote::new(count + 1, context.this_address());
                new_count_note
            })
            .emit(context.this_address(), MessageDelivery.CONSTRAINED_ONCHAIN);
    }

    #[external("private")]
    fn cast_vote(proposal_id: Field, choice: u32) {
        storage
            .members
            .replace(|note| {
                let msg_sender = context.msg_sender().unwrap();
                let mut is_member = false;

                // Check membership
                for i in 0..10 {
                    if note.members[i] == msg_sender.inner {
                        is_member = true;
                    }
                }
                assert(is_member, "Not a member");
                note
            })
            .emit(context.this_address(), MessageDelivery.CONSTRAINED_ONCHAIN);

        // Find the proposal
        let options = NoteGetterOptions::new().select(
            ProposalNote::properties().proposal_id,
            Comparator.EQ,
            proposal_id,
        );
        let notes = storage.proposals.pop_notes(options);
        assert(notes.len() == 1, "Proposal not found");

        // Create nullifier to prevent double voting
        let msg_sender_npk_hash = get_public_keys(context.msg_sender().unwrap()).npk_m.hash();
        let secret = context.request_nsk_app(msg_sender_npk_hash);
        let nullifier = poseidon2_hash([proposal_id, secret]);
        context.push_nullifier(nullifier);

        // Update the proposal with the vote
        let retrieved_note = notes.get_unchecked(0);

        // Use the vote method to update tally
        let updated_proposal = retrieved_note.vote(choice);

        // Remove old proposal and add updated one
        storage.proposals.insert(updated_proposal).emit(
            context.this_address(),
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    #[external("utility")]
    unconstrained fn _view_current_id() -> pub Field {
        let note = storage.last_proposal_id.view_note();
        note.value()
    }

    #[external("utility")]
    unconstrained fn _view_members() -> pub [Field; 10] {
        let note = storage.members.view_note();
        note.members
    }

    #[external("utility")]
    unconstrained fn _view_proposal(proposal_id: Field) -> ProposalNote {
        let options = NoteViewerOptions::new().select(
            ProposalNote::properties().proposal_id,
            Comparator.EQ,
            proposal_id,
        );
        let notes = storage.proposals.view_notes(options);
        assert(notes.len() == 1, "Proposal not found");
        notes.get_unchecked(0)
    }

}
