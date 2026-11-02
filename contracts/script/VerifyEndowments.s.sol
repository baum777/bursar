// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {Endowment} from "../src/endowment/Endowment.sol";
import {EndowmentFactory} from "../src/endowment/EndowmentFactory.sol";
import {PatronMark} from "../src/endowment/PatronMark.sol";

/// Asks the chain what `DeployEndowments.s.sol` wired: the factory has no owner, so everything it
/// will ever do is fixed in its immutables, and the live check reads every one of them against the
/// record. Then it lists each endowment the factory started, with who holds it and whether it is
/// frozen, so the daily report shows the endowments the way it shows every other contract.
abstract contract EndowmentChecks is Verifier {
    string internal constant ENDOWMENT_FACTORY = ".endowments.EndowmentFactory";
    string internal constant PATRON_MARK = ".endowments.PatronMark";
    string internal constant ENDOWMENT_DEPLOYER = ".endowments.EndowmentDeployer";
    string internal constant IDENTITY_REGISTRY = ".endowments.IdentityRegistry";
    string internal constant FEE_BPS = ".endowments.feeBps";

    function _checkEndowments() internal {
        if (_recordAddress(ENDOWMENT_FACTORY) == address(0)) return;
        address factory = _contract(ENDOWMENT_FACTORY);
        address marks = _contract(PATRON_MARK);
        address deployer = _contract(ENDOWMENT_DEPLOYER);
        if (factory == address(0) || marks == address(0) || deployer == address(0)) return;

        EndowmentFactory f = EndowmentFactory(factory);
        _is("EndowmentFactory.router", _recordAddress(K.STOCK_ROUTER), address(f.router()));
        _is("EndowmentFactory.guard", _recordAddress(K.PRICE_GUARD), address(f.guard()));
        _is("EndowmentFactory.registry", _recordAddress(K.ASSET_REGISTRY), address(f.registry()));
        _is("EndowmentFactory.usdg", _settlementAsset(), address(f.usdg()));
        _is("EndowmentFactory.identity", _recordAddress(IDENTITY_REGISTRY), address(f.identity()));
        _is("EndowmentFactory.marks", marks, address(f.marks()));
        _is("EndowmentFactory.feeTo", _recordAddress(K.TREASURY), f.feeTo());
        _isUint("EndowmentFactory.feeBps", _recordUint(FEE_BPS), f.feeBps());
        _is("EndowmentFactory.guardian", _recordAddress(K.GUARDIAN), f.guardian());
        _is("EndowmentFactory.deployer", deployer, address(f.deployer()));
        _is("PatronMark.factory", factory, address(PatronMark(marks).factory()));

        uint256 n = f.count();
        _fact("EndowmentFactory.count", n);
        for (uint256 i; i < n; ++i) {
            Endowment e = Endowment(f.all(i));
            string memory at = string.concat("Endowment[", vm.toString(i), "]");
            _fact(at, address(e));
            _is(string.concat(at, ".guard"), address(f.guard()), address(e.guard()));
            _is(string.concat(at, ".router"), address(f.router()), address(e.router()));
            _is(string.concat(at, ".guardian"), f.guardian(), e.guardian());
            _fact(string.concat(at, ".settlor"), e.settlor());
            _fact(string.concat(at, ".agentId"), e.agentId());
            _fact(string.concat(at, ".accepted"), e.accepted());
            _fact(string.concat(at, ".frozen"), e.frozen());
            _fact(string.concat(at, ".annualDraw"), e.annualDraw());
        }
    }
}

/// `forge script script/VerifyEndowments.s.sol --rpc-url "$RHC_RPC_URL"`, after `DeployEndowments.s.sol`.
contract VerifyEndowments is EndowmentChecks {
    function run() external {
        _begin();
        _checkEndowments();
        _end("endowments");
    }
}
