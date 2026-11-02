// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Endowment} from "../../src/endowment/Endowment.sol";
import {EndowmentTest} from "./Endowment.t.sol";

/// Each case an outside review showed against 2b18477, held closed: a fresh gift never reads as a
/// loss, a live agent can always say so, the settlor cannot pick the heir of a held endowment, cash
/// already owed is never swept into stock, and a gift in kind needs a price the guard stands behind.
contract EndowmentFixesTest is EndowmentTest {
    function _patronGives(Endowment e, uint256 amount) internal {
        vm.startPrank(patron);
        usdg.approve(address(e), type(uint256).max);
        e.give(amount);
        vm.stopPrank();
    }

    function _nextQuarterFlat() internal {
        vm.warp(block.timestamp + 90 days);
        spyFeed.set(int256(SPY_E8), block.timestamp);
    }

    function test_fix_aLargeGiftDoesNotStopTheDraw() public {
        Endowment e = _invested(100e6);
        assertEq(e.annualDraw(), 4e6);
        _nextQuarterFlat();
        _patronGives(e, 30e6);
        e.snapshot();
        assertGt(e.annualDraw(), 3.7e6, "a gift is not a loss");
        assertFalse(e.state().underwater);
    }

    function test_fix_theUnderwaterViewAgreesWithTheRule() public {
        Endowment e = _invested(100e6);
        _quarterAt(SPY_E8 * 70 / 100);
        assertEq(e.annualDraw(), 0);
        assertTrue(e.state().underwater);
    }

    function test_fix_aLiveAgentChecksInAndCannotBeLapsed() public {
        Endowment e = _create(100e6);
        vm.prank(principal);
        e.accept(address(acct));
        while (usdg.balanceOf(address(e)) > e.sleeveTarget() + 1e6) e.invest();

        _quarterAt(SPY_E8 * 70 / 100);
        assertEq(e.annualDraw(), 0);
        vm.prank(agent);
        e.draw();

        for (uint256 m = 1; m <= 6; ++m) {
            vm.warp(block.timestamp + 30 days);
            vm.prank(agent);
            vm.expectRevert(Endowment.NothingToDraw.selector);
            e.draw();
            vm.prank(agent);
            e.checkIn();
        }
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Endowment.StillActive.selector, e.lastActive() + 180 days));
        e.lapse();
    }

    function test_fix_onlyTheAgentsSideChecksIn() public {
        Endowment e = _accepted(100e6);
        vm.prank(stranger);
        vm.expectRevert(Endowment.NotDrawer.selector);
        e.checkIn();
        vm.prank(settlor);
        vm.expectRevert(Endowment.NotDrawer.selector);
        e.checkIn();
    }

    function test_fix_theSettlorCannotNameTheHeirOfAHeldEndowmentAlone() public {
        Endowment e = _accepted(100e6);
        vm.prank(settlor);
        e.setSuccessor(SUCCESSOR);
        assertEq(e.successorId(), 0, "a proposal is not an heir");
        assertEq(e.proposedSuccessor(), SUCCESSOR);

        // The agent's owner cannot write its own pick over the settlor's terms either.
        vm.prank(principal);
        vm.expectRevert(Endowment.NotSettlor.selector);
        e.setSuccessor(SUCCESSOR + 1);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(Endowment.NotProposed.selector, SUCCESSOR + 1));
        e.confirmSuccessor(SUCCESSOR + 1);
        vm.prank(stranger);
        vm.expectRevert(Endowment.NotOwner.selector);
        e.confirmSuccessor(SUCCESSOR);

        vm.prank(principal);
        e.confirmSuccessor(SUCCESSOR);
        assertEq(e.successorId(), SUCCESSOR);
        assertEq(e.proposedSuccessor(), 0);
    }

    function test_fix_aLargeGiftThenADipDoesNotStopTheDraw() public {
        Endowment e = _invested(100e6);
        _nextQuarterFlat();
        _patronGives(e, 900e6);
        while (usdg.balanceOf(address(e)) > e.sleeveTarget() + 26e6) e.invest();
        _quarterAt(SPY_E8 * 97 / 100);
        assertGt(e.annualDraw(), 0, "a 3% dip on a gifted fund is not a 20% loss");
        assertFalse(e.state().underwater);
    }

    function test_fix_aFreezeDoesNotCountAgainstTheAgent() public {
        Endowment e = _accepted(100e6);
        vm.prank(e.guardian());
        e.setFrozen(true);
        vm.warp(block.timestamp + 200 days);
        vm.expectRevert(Endowment.IsFrozen.selector);
        e.lapse();
    }

    function test_fix_investLeavesWhatIsOwed() public {
        Endowment e = _invested(100e6);
        _quarterAt(SPY_E8 * 70 / 100);
        uint256 owed = e.accrued();
        assertGt(owed, 0.9e6);
        _patronGives(e, 5e6);
        vm.prank(stranger);
        e.invest();
        assertGe(usdg.balanceOf(address(e)), e.banked(), "the banked draw stays in cash");
        vm.prank(agent);
        e.draw();
    }

    function test_fix_giveStockRefusesAPriceTheGuardDoesNotStandBehind() public {
        Endowment e = _create(100e6);
        vm.warp(block.timestamp + 27 hours);
        _setPool(spy, SPY_E8 / 2);
        (uint256 p,, bool fresh) = guard.valuationPrice(address(spy));
        assertFalse(fresh);
        uint256 raw = Math.mulDiv(100e6, 10 ** (uint256(reg.get(address(spy)).decimals) + 2), p);
        spy.mint(stranger, raw);
        vm.startPrank(stranger);
        IERC20(address(spy)).approve(address(e), raw);
        vm.expectRevert(abi.encodeWithSelector(Endowment.StaleValuation.selector, address(spy)));
        e.giveStock(address(spy), raw);
        vm.stopPrank();
    }
}
