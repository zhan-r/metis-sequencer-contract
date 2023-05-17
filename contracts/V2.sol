// SPDX-License-Identifier: MIT
pragma solidity 0.8.2;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";


contract V2 is Initializable{
   uint public number;

    function initialize(uint _num) public initializer {
        number=_num;
    }


   function increase() external {
       number += 1;
   }

   function decrease() external {
       number -= 1;
   }
}