// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Endowment} from "../../src/endowment/Endowment.sol";
import {EndowmentFactory} from "../../src/endowment/EndowmentFactory.sol";
import {RemoteIdentity} from "../../src/endowment/RemoteIdentity.sol";
import {EndowmentTest} from "./Endowment.t.sol";

/// An endowment for an agent on another chain: the owner the attestor read there accepts, draws
/// and sets the mandate on Robinhood Chain with the same key.
contract RemoteEndowmentTest is EndowmentTest {
    uint64 internal constant BASE = 8453;
    uint64 internal constant ETHEREUM = 1;
    uint256 internal constant BASE_AGENT = 795_681;
    address remoteOwner = makeAddr("remoteOwner");

    function _remoteTerms(uint64 chainId, uint256 agentId) internal view returns (Endowment.Terms memory t) {
        t = _terms();
        t.agentId = remote.idOf(chainId, agentId);
        t.successorId = 0;
    }

    function test_idEncodesChainAndAgent() public view {
        uint256 id = remote.idOf(BASE, BASE_AGENT);
        assertEq(remote.chainOf(id), BASE);
        assertEq(remote.agentOf(id), BASE_AGENT);
        assertTrue(remote.idOf(ETHEREUM, BASE_AGENT) != id);
        assertTrue(remote.idOf(BASE, BASE_AGENT + 1) != id);
    }

    function test_idRefusesZeroChainAndOversizedAgent() public {
        vm.expectRevert(abi.encodeWithSelector(RemoteIdentity.BadChainId.selector, uint64(0)));
        remote.idOf(0, 1);
        vm.expectRevert(abi.encodeWithSelector(RemoteIdentity.BadAgentId.selector, uint256(1) << 160));
        remote.idOf(BASE, uint256(1) << 160);
    }

    function test_onlyTheAttestorWrites() public {
        vm.prank(stranger);
        vm.expectRevert(RemoteIdentity.NotAttestor.selector);
        remote.attest(BASE, BASE_AGENT, remoteOwner);
        vm.prank(attestor);
        remote.attest(BASE, BASE_AGENT, remoteOwner);
        assertEq(remote.ownerOf(remote.idOf(BASE, BASE_AGENT)), remoteOwner);
        assertTrue(remote.attested(BASE, BASE_AGENT));
    }

    function test_unknownAgentRevertsLikeARegistry() public {
        uint256 id = remote.idOf(BASE, BASE_AGENT);
        vm.expectRevert(abi.encodeWithSelector(RemoteIdentity.Unknown.selector, id));
        remote.ownerOf(id);
        assertFalse(remote.attested(BASE, BASE_AGENT));
    }

    function test_factoryRefusesAnAgentNeverAttested() public {
        Endowment.Terms memory t = _remoteTerms(BASE, BASE_AGENT);
        vm.prank(settlor);
        vm.expectRevert(abi.encodeWithSelector(RemoteIdentity.Unknown.selector, t.agentId));
        factory.createRemote(BASE, BASE_AGENT, t, 0);
    }

    function test_factoryRefusesAMismatchedId() public {
        vm.prank(attestor);
        remote.attest(BASE, BASE_AGENT, remoteOwner);
        Endowment.Terms memory t = _terms(); // agentId = AGENT on this chain, not the remote id
        vm.prank(settlor);
        vm.expectRevert(abi.encodeWithSelector(EndowmentFactory.NotRemoteId.selector, t.agentId));
        factory.createRemote(BASE, BASE_AGENT, t, 0);
    }

    function test_remoteOwnerAcceptsDrawsAndIsListed() public {
        vm.prank(attestor);
        remote.attest(BASE, BASE_AGENT, remoteOwner);
        Endowment.Terms memory t = _remoteTerms(BASE, BASE_AGENT);

        vm.prank(settlor);
        Endowment e = factory.createRemote(BASE, BASE_AGENT, t, 100e6);
        assertTrue(factory.isEndowment(address(e)));
        assertEq(factory.endowmentsOf(BASE, BASE_AGENT).length, 1);
        assertEq(factory.endowmentsOf(BASE, BASE_AGENT)[0], address(e));
        assertEq(factory.endowmentsOf(ETHEREUM, BASE_AGENT).length, 0);
        assertEq(e.agentId(), remote.idOf(BASE, BASE_AGENT));

        // The agent's owner on this chain (a stranger to the remote one) cannot accept it.
        vm.prank(principal);
        vm.expectRevert(Endowment.NotOwner.selector);
        e.accept(address(acct));

        vm.prank(remoteOwner);
        e.accept(address(acct));
        assertTrue(e.accepted());

        vm.warp(block.timestamp + 30 days);
        uint256 before = usdg.balanceOf(address(acct));
        vm.prank(remoteOwner);
        uint256 paid = e.draw();
        assertGt(paid, 0);
        assertGt(usdg.balanceOf(address(acct)), before);
    }

    function test_aTransferredAgentMovesWithItsOwner() public {
        vm.prank(attestor);
        remote.attest(BASE, BASE_AGENT, remoteOwner);
        Endowment.Terms memory t = _remoteTerms(BASE, BASE_AGENT);
        vm.prank(settlor);
        Endowment e = factory.createRemote(BASE, BASE_AGENT, t, 100e6);

        address next = makeAddr("nextOwner");
        vm.prank(attestor);
        remote.attest(BASE, BASE_AGENT, next);

        vm.prank(remoteOwner);
        vm.expectRevert(Endowment.NotOwner.selector);
        e.accept(address(acct));
        vm.prank(next);
        e.accept(address(acct));
        assertTrue(e.accepted());
    }

    function test_anyoneRequestsOnceAndTheKeeperReadsFromACursor() public {
        vm.prank(stranger);
        remote.request(BASE, BASE_AGENT);
        vm.prank(patron);
        remote.request(BASE, BASE_AGENT);
        vm.prank(patron);
        remote.request(ETHEREUM, 42);
        assertEq(remote.requestCount(), 2);
        assertTrue(remote.requested(remote.idOf(BASE, BASE_AGENT)));

        uint256[] memory ids = remote.requestsFrom(0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], remote.idOf(BASE, BASE_AGENT));
        assertEq(ids[1], remote.idOf(ETHEREUM, 42));
        assertEq(remote.requestsFrom(1, 10).length, 1);
        assertEq(remote.requestsFrom(2, 10).length, 0);
        assertEq(remote.requestsFrom(0, 1).length, 1);

        vm.expectRevert(abi.encodeWithSelector(RemoteIdentity.BadChainId.selector, uint64(0)));
        remote.request(0, 1);
    }

    function test_attestManyWritesEachAndChecksLengths() public {
        uint64[] memory chains = new uint64[](2);
        uint256[] memory agents = new uint256[](2);
        address[] memory owners = new address[](2);
        chains[0] = BASE;
        chains[1] = ETHEREUM;
        agents[0] = BASE_AGENT;
        agents[1] = 42;
        owners[0] = remoteOwner;
        owners[1] = makeAddr("ethOwner");
        vm.prank(attestor);
        remote.attestMany(chains, agents, owners);
        assertEq(remote.ownerOf(remote.idOf(BASE, BASE_AGENT)), remoteOwner);
        assertEq(remote.ownerOf(remote.idOf(ETHEREUM, 42)), owners[1]);

        address[] memory short = new address[](1);
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(RemoteIdentity.BadAgentId.selector, uint256(2)));
        remote.attestMany(chains, agents, short);
    }
}
