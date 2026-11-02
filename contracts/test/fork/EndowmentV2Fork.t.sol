// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Endowment} from "../../src/endowment/Endowment.sol";
import {EndowmentFactory} from "../../src/endowment/EndowmentFactory.sol";

/// A freshly deployed factory against the live chain: the real router, guard and stock list.
/// Runs only with ENDOW_V2_FORK_URL and ENDOW_V2_FACTORY set, so the default suite stays offline.
contract EndowmentV2ForkTest is Test {
    address private constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address private constant EXAMPLE_MANDATE = 0x4E94861260fD68E7375220D67CA8959e93924bd4;
    uint256 private constant AGENT = 8756;

    EndowmentFactory private factory;
    IERC20 private usdg;
    address private owner;
    address private settlor = makeAddr("settlor");
    address private patron = makeAddr("patron");

    function setUp() public {
        string memory url = vm.envOr("ENDOW_V2_FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        factory = EndowmentFactory(vm.envAddress("ENDOW_V2_FACTORY"));
        usdg = factory.usdg();
        owner = IERC721(address(factory.identity())).ownerOf(AGENT);
        deal(address(usdg), settlor, 10e6);
        deal(address(usdg), patron, 10e6);
    }

    function _terms() private pure returns (Endowment.Terms memory t) {
        address[] memory assets = new address[](1);
        assets[0] = SPY;
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        t = Endowment.Terms({agentId: AGENT, successorId: 0, assets: assets, weightsBps: weights, drawBps: 450, earnShareBps: 5_000});
    }

    function test_fork_createGiveAcceptInvestAndCheckIn() public {
        vm.startPrank(settlor);
        usdg.approve(address(factory), 4e6);
        Endowment e = factory.create(_terms(), 4e6);
        vm.stopPrank();
        assertTrue(factory.isEndowment(address(e)));

        vm.prank(owner);
        e.accept(EXAMPLE_MANDATE);

        // A large fresh gift is the M-1 trigger: it must not read as a loss.
        vm.startPrank(patron);
        usdg.approve(address(e), 6e6);
        e.give(6e6);
        vm.stopPrank();
        Endowment.State memory s = e.state();
        assertTrue(s.accepted);
        assertEq(s.contributed, 10e6);
        assertFalse(s.underwater);

        uint256 bought = e.invest();
        assertGt(bought, 0, "the live router bought SPY");
        s = e.state();
        assertGe(s.cash, e.sleeveTarget(), "the sleeve keeps what the draw needs");
        assertFalse(s.underwater, "an invested gift is not a loss");

        vm.prank(owner);
        e.checkIn();
        assertEq(e.state().lastActive, block.timestamp);
    }
}
